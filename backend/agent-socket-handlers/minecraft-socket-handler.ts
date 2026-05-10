import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { Settings } from "../settings";
import { InteractiveTerminal, Terminal } from "../terminal";
import childProcessAsync from "promisify-child-process";
import { promises as fsAsync } from "fs";
import path from "path";
import AdmZip from "adm-zip";
import * as YAML from "yaml";
import { log } from "../log";
import { TERMINAL_ROWS } from "../../common/util-common";
import { getRconSession } from "./minecraft-rcon-session";

const MINECRAFT_IMAGES = [ "itzg/minecraft-server", "itzg/mc-proxy" ];

function getMinecraftAttachTerminalName(endpoint: string, stackName: string, serviceName: string): string {
    return `minecraft-attach-${endpoint}-${stackName}-${serviceName}`;
}

function safePath(stackPath: string, relPath: string): string {
    const resolved = path.resolve(stackPath, relPath);
    if (!resolved.startsWith(path.resolve(stackPath))) {
        throw new ValidationError("Path traversal detected");
    }
    return resolved;
}

async function findContainerName(stackPath: string, serviceName: string): Promise<string | null> {
    try {
        const res = await childProcessAsync.spawn("docker", [ "compose", "ps", "--format", "json" ], {
            cwd: stackPath,
            encoding: "utf-8",
        });
        const stdout = res.stdout?.toString() ?? "";
        for (const line of stdout.split("\n")) {
            try {
                const obj = JSON.parse(line);
                const items = Array.isArray(obj) ? obj : [ obj ];
                for (const item of items) {
                    if (item.Service === serviceName || serviceName === "") {
                        return item.Name as string;
                    }
                }
            } catch (_) { /* skip */ }
        }
    } catch (e) {
        log.warn("findContainerName", "Failed to get container name: " + e);
    }
    return null;
}

async function loadComposeDoc(stackPath: string): Promise<{ doc: YAML.Document.Parsed, actualPath: string }> {
    const composePath = path.join(stackPath, "compose.yaml");
    let actualPath = composePath;
    try {
        await fsAsync.access(composePath);
    } catch {
        actualPath = path.join(stackPath, "compose.yml");
    }
    const raw = await fsAsync.readFile(actualPath, "utf-8");
    const doc = YAML.parseDocument(raw);
    return { doc,
        actualPath };
}

// Read the service's `environment:` (map or seq) into a plain object.
function readComposeEnv(svc: YAML.YAMLMap): Record<string, string> {
    const env = svc.get("environment", true) as unknown;
    const out: Record<string, string> = {};
    if (env instanceof YAML.YAMLMap) {
        for (const item of env.items) {
            const k = item.key instanceof YAML.Scalar ? String(item.key.value) : String(item.key);
            const v = item.value instanceof YAML.Scalar ? item.value.value : item.value;
            out[k] = v == null ? "" : String(v);
        }
    } else if (env instanceof YAML.YAMLSeq) {
        for (const item of env.items) {
            const raw = (item instanceof YAML.Scalar) ? String(item.value) : (typeof item === "string" ? item : "");
            const eq = raw.indexOf("=");
            if (eq === -1) {
                out[raw] = "";
            } else {
                out[raw.slice(0, eq)] = raw.slice(eq + 1);
            }
        }
    }
    return out;
}

// Write a single env var into the service, preserving the existing
// representation (YAMLMap vs YAMLSeq). Mirrors the inline helper used by
// minecraftSetLimits so seq-style envs ("KEY=VAL") aren't clobbered into a map.
function setEnvVarOnService(svc: YAML.YAMLMap, key: string, value: string | null | undefined) {
    const empty = value === null || value === undefined || value === "";
    const env = svc.get("environment", true) as unknown;

    if (env instanceof YAML.YAMLSeq) {
        let found = -1;
        for (let i = 0; i < env.items.length; i++) {
            const item = env.items[i];
            const raw = (item instanceof YAML.Scalar) ? String(item.value) : (typeof item === "string" ? item : "");
            const eq = raw.indexOf("=");
            const k = eq === -1 ? raw : raw.slice(0, eq);
            if (k === key) {
                found = i;
                break;
            }
        }
        if (empty) {
            if (found !== -1) {
                env.items.splice(found, 1);
            }
        } else {
            const newScalar = new YAML.Scalar(`${key}=${value}`);
            if (found !== -1) {
                env.items[found] = newScalar;
            } else {
                env.items.push(newScalar);
            }
        }
        return;
    }

    if (env instanceof YAML.YAMLMap) {
        if (empty) {
            env.delete(key);
        } else {
            env.set(key, value);
        }
        return;
    }

    if (!empty) {
        const m = new YAML.YAMLMap();
        m.set(key, value);
        svc.set("environment", m);
    }
}

export class MinecraftSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket) {

        agentSocket.on("setStackMinecraftView", async (stackName: unknown, mode: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof mode !== "string" || ![ "auto", "on", "off" ].includes(mode)) {
                    throw new ValidationError("Mode must be auto, on, or off");
                }
                await Settings.set(`minecraftView_${stackName}`, { mode }, "minecraft");
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStackMinecraftSettings", async (callback) => {
            try {
                checkLogin(socket);
                const allSettings = await Settings.getSettings("minecraft");
                callbackResult({ ok: true,
                    settings: allSettings }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftAttach", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof serviceName !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const terminalName = getMinecraftAttachTerminalName(socket.endpoint, stackName, serviceName);

                let terminal = Terminal.getTerminal(terminalName);

                if (!terminal) {
                    const containerName = await findContainerName(stack.path, serviceName);

                    if (!containerName) {
                        throw new ValidationError("Container not found or not running");
                    }

                    terminal = new InteractiveTerminal(server, terminalName, "docker", [ "attach", containerName ], stack.path);
                    terminal.rows = TERMINAL_ROWS;
                    terminal.enableKeepAlive = true;
                }

                terminal.join(socket);
                terminal.start();

                callbackResult({ ok: true,
                    terminalName }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFilelist", async (stackName: unknown, relPath: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);

                const rawEntries = await fsAsync.readdir(targetPath, { withFileTypes: true });
                const entries = await Promise.all(rawEntries.map(async (entry) => {
                    const entryPath = path.join(targetPath, entry.name);
                    let size = 0;
                    let mtime = 0;
                    try {
                        const stat = await fsAsync.stat(entryPath);
                        size = stat.size;
                        mtime = stat.mtimeMs;
                    } catch (_) { /* skip */ }
                    return {
                        name: entry.name,
                        isDir: entry.isDirectory(),
                        size,
                        mtime,
                    };
                }));

                // Sort: dirs first, then files, alphabetically
                entries.sort((a, b) => {
                    if (a.isDir !== b.isDir) {
                        return a.isDir ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });

                callbackResult({ ok: true,
                    entries }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileRead", async (stackName: unknown, relPath: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);

                const stat = await fsAsync.stat(targetPath);
                if (stat.size > 5 * 1024 * 1024) {
                    throw new ValidationError("File too large to edit (max 5MB)");
                }

                const content = await fsAsync.readFile(targetPath, "utf-8");
                callbackResult({ ok: true,
                    content }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileSave", async (stackName: unknown, relPath: unknown, content: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }
                if (typeof content !== "string") {
                    throw new ValidationError("Content must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);

                await fsAsync.writeFile(targetPath, content, "utf-8");
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileDelete", async (stackName: unknown, relPath: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);

                const stat = await fsAsync.stat(targetPath);
                if (stat.isDirectory()) {
                    await fsAsync.rm(targetPath, { recursive: true,
                        force: true });
                } else {
                    await fsAsync.unlink(targetPath);
                }
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileRename", async (stackName: unknown, relPath: unknown, newName: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }
                if (typeof newName !== "string") {
                    throw new ValidationError("New name must be a string");
                }
                if (newName.includes("/") || newName.includes("\\") || newName === ".." || newName === ".") {
                    throw new ValidationError("Invalid file name");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);
                const newPath = path.join(path.dirname(targetPath), newName);

                // Ensure the new path is still within the stack directory
                safePath(stack.path, path.relative(stack.path, newPath));

                await fsAsync.rename(targetPath, newPath);
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileTouch", async (stackName: unknown, relPath: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);

                try {
                    await fsAsync.access(targetPath);
                    throw new ValidationError("File already exists");
                } catch (err: unknown) {
                    if (err instanceof ValidationError) {
                        throw err;
                    }
                }

                await fsAsync.writeFile(targetPath, "", { flag: "wx" });
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileUnzip", async (stackName: unknown, relPath: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);
                const destDir = path.dirname(targetPath);

                const zip = new AdmZip(targetPath);
                const entries = zip.getEntries();
                // Reject any entry that would escape destDir.
                for (const entry of entries) {
                    const resolved = path.resolve(destDir, entry.entryName);
                    if (!resolved.startsWith(path.resolve(destDir))) {
                        throw new ValidationError(`Refusing to extract entry outside target dir: ${entry.entryName}`);
                    }
                }
                zip.extractAllTo(destDir, true);
                callbackResult({ ok: true,
                    count: entries.length }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftSetLimits", async (stackName: unknown, serviceName: unknown, limits: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof serviceName !== "string" || !serviceName) {
                    throw new ValidationError("Service name must be a non-empty string");
                }
                if (!limits || typeof limits !== "object") {
                    throw new ValidationError("Limits must be an object");
                }
                const l = limits as Record<string, unknown>;

                const stack = await Stack.getStack(server, stackName);
                const { doc,
                    actualPath } = await loadComposeDoc(stack.path);

                const services = doc.get("services") as YAML.YAMLMap | undefined;
                if (!services || !YAML.isMap(services)) {
                    throw new ValidationError("compose has no services map");
                }
                const svc = services.get(serviceName) as YAML.YAMLMap | undefined;
                if (!svc || !YAML.isMap(svc)) {
                    throw new ValidationError(`Service ${serviceName} not found in compose`);
                }

                // Walk the YAML tree directly via YAMLMap.set/.delete instead
                // of doc.setIn — that fails with "Expected YAML collection at
                // X" when an intermediate key already exists as a scalar
                // (e.g. `reservations:` with no value), and silently inserts
                // plain JS objects rather than YAMLMap nodes.
                const ensureMapAt = (parent: YAML.YAMLMap, key: string): YAML.YAMLMap => {
                    const existing = parent.get(key, true);
                    if (existing instanceof YAML.YAMLMap) {
                        return existing;
                    }
                    const m = new YAML.YAMLMap();
                    parent.set(key, m);
                    return m;
                };

                const setOrDel = (parent: YAML.YAMLMap, key: string, value: string | null) => {
                    if (value === null || value === undefined || value === "") {
                        parent.delete(key);
                    } else {
                        parent.set(key, value);
                    }
                };

                const cpuLimit = l.cpuLimit as string | number | null | undefined;
                const memLimit = l.memLimit as string | null | undefined;
                const cpuRes = l.cpuReservation as string | number | null | undefined;
                const memRes = l.memReservation as string | null | undefined;
                const initMemory = l.initMemory as string | null | undefined;
                const maxMemory = l.maxMemory as string | null | undefined;

                const deploy = ensureMapAt(svc, "deploy");
                const resources = ensureMapAt(deploy, "resources");
                const limitsMap = ensureMapAt(resources, "limits");
                const reservationsMap = ensureMapAt(resources, "reservations");

                setOrDel(limitsMap, "cpus", cpuLimit ? String(cpuLimit) : null);
                setOrDel(limitsMap, "memory", memLimit || null);
                setOrDel(reservationsMap, "cpus", cpuRes ? String(cpuRes) : null);
                setOrDel(reservationsMap, "memory", memRes || null);

                // Prune empty parents so we don't leave behind `reservations: {}`
                // / `deploy: {}` etc.
                if (limitsMap.items.length === 0) {
                    resources.delete("limits");
                }
                if (reservationsMap.items.length === 0) {
                    resources.delete("reservations");
                }
                if (resources.items.length === 0) {
                    deploy.delete("resources");
                }
                if (deploy.items.length === 0) {
                    svc.delete("deploy");
                }

                // JVM memory env vars (INIT_MEMORY/MAX_MEMORY). The
                // `environment` key may be a YAMLMap ({KEY: VAL}) or a YAMLSeq
                // of "KEY=VAL" strings — handle both so we don't clobber the
                // user's existing style.
                setEnvVarOnService(svc, "INIT_MEMORY", initMemory || null);
                setEnvVarOnService(svc, "MAX_MEMORY", maxMemory || null);

                const finalEnv = svc.get("environment", true) as unknown;
                if (finalEnv instanceof YAML.YAMLMap && finalEnv.items.length === 0) {
                    svc.delete("environment");
                } else if (finalEnv instanceof YAML.YAMLSeq && finalEnv.items.length === 0) {
                    svc.delete("environment");
                }

                await fsAsync.writeFile(actualPath, doc.toString(), "utf-8");
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftSetEnv", async (stackName: unknown, serviceName: unknown, envMap: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof serviceName !== "string" || !serviceName) {
                    throw new ValidationError("Service name must be a non-empty string");
                }
                if (!envMap || typeof envMap !== "object" || Array.isArray(envMap)) {
                    throw new ValidationError("envMap must be an object");
                }
                const desired: Record<string, string> = {};
                for (const [ k, v ] of Object.entries(envMap as Record<string, unknown>)) {
                    if (!k || typeof k !== "string") {
                        continue;
                    }
                    desired[k] = v == null ? "" : String(v);
                }

                const stack = await Stack.getStack(server, stackName);
                const { doc,
                    actualPath } = await loadComposeDoc(stack.path);

                const services = doc.get("services") as YAML.YAMLMap | undefined;
                if (!services || !YAML.isMap(services)) {
                    throw new ValidationError("compose has no services map");
                }
                const svc = services.get(serviceName) as YAML.YAMLMap | undefined;
                if (!svc || !YAML.isMap(svc)) {
                    throw new ValidationError(`Service ${serviceName} not found in compose`);
                }

                // Diff existing env against desired and apply changes,
                // preserving the existing map/seq representation.
                const existing = readComposeEnv(svc);
                for (const k of Object.keys(existing)) {
                    if (!(k in desired)) {
                        setEnvVarOnService(svc, k, null);
                    }
                }
                for (const [ k, v ] of Object.entries(desired)) {
                    setEnvVarOnService(svc, k, v);
                }

                const finalEnv = svc.get("environment", true) as unknown;
                if (finalEnv instanceof YAML.YAMLMap && finalEnv.items.length === 0) {
                    svc.delete("environment");
                } else if (finalEnv instanceof YAML.YAMLSeq && finalEnv.items.length === 0) {
                    svc.delete("environment");
                }

                await fsAsync.writeFile(actualPath, doc.toString(), "utf-8");
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftRconExec", async (stackName: unknown, serviceName: unknown, command: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof serviceName !== "string") {
                    throw new ValidationError("Service name must be a string");
                }
                if (typeof command !== "string" || !command.trim()) {
                    throw new ValidationError("Command must be a non-empty string");
                }
                // rcon-cli accepts the command as a single argument; pass it
                // verbatim. Container-level isolation makes shell injection
                // through the docker exec argv non-applicable here.
                const stack = await Stack.getStack(server, stackName);
                const containerName = await findContainerName(stack.path, serviceName);
                if (!containerName) {
                    callbackResult({ ok: false,
                        msg: "Container not running" }, callback);
                    return;
                }
                // Reuse a long-lived `docker exec -i ... rcon-cli` per
                // container so the Minecraft server logs one TCP
                // connect/disconnect pair for the whole session, not one
                // per command. See minecraft-rcon-session.ts.
                const sessionKey = `${socket.endpoint}::${stackName}::${serviceName}`;
                const session = getRconSession(sessionKey, containerName);
                const res = await session.exec(command, 5000);
                callbackResult({ ok: res.ok,
                    stdout: res.stdout,
                    stderr: res.stderr,
                    code: res.code }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftInspect", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof serviceName !== "string") {
                    throw new ValidationError("Service name must be a string");
                }
                const stack = await Stack.getStack(server, stackName);
                const containerName = await findContainerName(stack.path, serviceName);
                if (!containerName) {
                    callbackResult({ ok: false,
                        msg: "Container not running" }, callback);
                    return;
                }
                const res = await childProcessAsync.spawn(
                    "docker",
                    [ "inspect", "--format", "{{.State.StartedAt}}|{{.State.Status}}", containerName ],
                    { encoding: "utf-8",
                        timeout: 5000 }
                );
                const stdout = (res.stdout?.toString() ?? "").trim();
                const [ startedAt, status ] = stdout.split("|");
                callbackResult({ ok: true,
                    startedAt: startedAt || "",
                    status: status || "" }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftFileMkdir", async (stackName: unknown, relPath: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof relPath !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const targetPath = safePath(stack.path, relPath);

                await fsAsync.mkdir(targetPath, { recursive: true });
                callbackResult({ ok: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
