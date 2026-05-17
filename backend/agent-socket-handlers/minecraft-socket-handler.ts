import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { Settings } from "../settings";
import { InteractiveTerminal, Terminal } from "../terminal";
import childProcessAsync from "promisify-child-process";
import { spawn, ChildProcess } from "child_process";
import { promises as fsAsync } from "fs";
import path from "path";
import AdmZip from "adm-zip";
import * as YAML from "yaml";
import { log } from "../log";
import { TERMINAL_ROWS } from "../../common/util-common";
import { LimitQueue } from "../utils/limit-queue";
import { getRconSession } from "./minecraft-rcon-session";

const MINECRAFT_IMAGES = [ "itzg/minecraft-server", "itzg/mc-proxy" ];

// Server-log history that outlives the docker-attach PTY. A long-running
// `docker logs -f` follower per (stack, service) writes into a ring buffer;
// the buffer is replayed when a client (re)attaches, so the terminal keeps
// the previous run's tail across container restarts and page refreshes.
// Cleared explicitly when the stack is stopped (`minecraftClearHistory`).
type HistoryEntry = {
    buffer: LimitQueue<string>;
    follower: ChildProcess | null;
    stackPath: string;
    serviceName: string;
    respawnTimer: NodeJS.Timeout | null;
    closing: boolean;
};

// ~4000 chunks of pty output — well above docker logs --tail and enough to
// hold the previous run + several minutes of the current run.
const HISTORY_LIMIT = 4000;
const RESPAWN_DELAY_MS = 2000;

const historyMap = new Map<string, HistoryEntry>();

function getHistoryEntry(terminalName: string, stackPath: string, serviceName: string): HistoryEntry {
    let entry = historyMap.get(terminalName);
    if (!entry) {
        entry = {
            buffer: new LimitQueue<string>(HISTORY_LIMIT),
            follower: null,
            stackPath,
            serviceName,
            respawnTimer: null,
            closing: false,
        };
        historyMap.set(terminalName, entry);
    } else {
        // Keep paths current — stacks can be moved/renamed at the disk level.
        entry.stackPath = stackPath;
        entry.serviceName = serviceName;
    }
    return entry;
}

function startFollower(terminalName: string, containerName: string) {
    const entry = historyMap.get(terminalName);
    if (!entry || entry.closing || entry.follower) {
        return;
    }

    const proc = spawn("docker", [ "logs", "-f", "--tail", String(HISTORY_LIMIT), containerName ], {
        stdio: [ "ignore", "pipe", "pipe" ],
    });
    entry.follower = proc;

    const onChunk = (data: Buffer) => {
        entry.buffer.pushItem(data.toString("utf-8"));
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);

    proc.on("exit", () => {
        if (entry.follower === proc) {
            entry.follower = null;
        }
        if (entry.closing) {
            return;
        }
        // Container restarted (or was paused). Try again shortly; if the
        // container is gone for good the frontend will issue a
        // minecraftClearHistory which sets `closing` and stops us.
        entry.respawnTimer = setTimeout(() => {
            entry.respawnTimer = null;
            respawnFollower(terminalName).catch(e => {
                log.warn("MinecraftHistory", "Respawn failed for " + terminalName + ": " + e);
            });
        }, RESPAWN_DELAY_MS);
    });

    proc.on("error", (err) => {
        log.warn("MinecraftHistory", "Follower error for " + terminalName + ": " + err.message);
    });
}

async function respawnFollower(terminalName: string) {
    const entry = historyMap.get(terminalName);
    if (!entry || entry.closing || entry.follower) {
        return;
    }
    const containerName = await findContainerName(entry.stackPath, entry.serviceName);
    if (!containerName) {
        // Container not back yet — try again until the stack is explicitly
        // stopped (which clears the entry) or it returns.
        entry.respawnTimer = setTimeout(() => {
            entry.respawnTimer = null;
            respawnFollower(terminalName).catch(() => {});
        }, RESPAWN_DELAY_MS);
        return;
    }
    startFollower(terminalName, containerName);
}

function stopFollower(terminalName: string) {
    const entry = historyMap.get(terminalName);
    if (!entry) {
        return;
    }
    entry.closing = true;
    if (entry.respawnTimer) {
        clearTimeout(entry.respawnTimer);
        entry.respawnTimer = null;
    }
    if (entry.follower) {
        try {
            entry.follower.kill("SIGTERM");
        } catch (_) { /* ignore */ }
        entry.follower = null;
    }
    historyMap.delete(terminalName);
}

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

        agentSocket.on("getMinecraftGlobalSettings", async (callback) => {
            try {
                checkLogin(socket);
                const raw = await Settings.get("displayHistoricTerminalLog");
                const displayHistoricTerminalLog = raw === undefined || raw === null ? true : !!raw;
                callbackResult({ ok: true,
                    displayHistoricTerminalLog }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("setMinecraftGlobalSettings", async (settings: unknown, callback) => {
            try {
                checkLogin(socket);
                if (!settings || typeof settings !== "object") {
                    throw new ValidationError("Settings must be an object");
                }
                const { displayHistoricTerminalLog } = settings as { displayHistoricTerminalLog?: unknown };
                if (typeof displayHistoricTerminalLog !== "boolean") {
                    throw new ValidationError("displayHistoricTerminalLog must be a boolean");
                }
                await Settings.set("displayHistoricTerminalLog", displayHistoricTerminalLog, "minecraft");
                callbackResult({ ok: true }, callback);
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
                let resolvedContainer: string | null = null;

                if (!terminal) {
                    resolvedContainer = await findContainerName(stack.path, serviceName);

                    if (!resolvedContainer) {
                        throw new ValidationError("Container not found or not running");
                    }

                    terminal = new InteractiveTerminal(server, terminalName, "docker", [ "attach", resolvedContainer ], stack.path);
                    terminal.rows = TERMINAL_ROWS;
                    terminal.enableKeepAlive = true;
                }

                // The follower is the long-running `docker logs -f` that
                // outlives the docker-attach PTY so its ring buffer survives
                // container restarts. Only spin it up when the user wants the
                // historic-log behaviour; otherwise the terminal only sees
                // live `docker attach` output.
                const historyRaw = await Settings.get("displayHistoricTerminalLog");
                const displayHistoricTerminalLog = historyRaw === undefined || historyRaw === null ? true : !!historyRaw;
                if (displayHistoricTerminalLog) {
                    const history = getHistoryEntry(terminalName, stack.path, serviceName);
                    history.closing = false;
                    if (!history.follower) {
                        const followerContainer = resolvedContainer ?? await findContainerName(stack.path, serviceName);
                        if (followerContainer) {
                            startFollower(terminalName, followerContainer);
                        }
                    }
                } else {
                    stopFollower(terminalName);
                }

                terminal.join(socket);
                terminal.start();

                callbackResult({ ok: true,
                    terminalName }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftRequestHistory", async (terminalName: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof terminalName !== "string") {
                    throw new ValidationError("Terminal name must be a string");
                }
                const entry = historyMap.get(terminalName);
                const data = entry && entry.buffer.length > 0 ? entry.buffer.join("") : "";
                if (data) {
                    socket.emitAgent("terminalWrite", terminalName, data);
                }
                callbackResult({ ok: true,
                    length: data.length }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftClearHistory", async (terminalName: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof terminalName !== "string") {
                    throw new ValidationError("Terminal name must be a string");
                }
                stopFollower(terminalName);
                callbackResult({ ok: true }, callback);
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

        agentSocket.on("minecraftGetPublicAddress", async (callback) => {
            try {
                checkLogin(socket);
                const ip = await server.getPublicIp();
                callbackResult({ ok: true,
                    ip }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("minecraftDiskUsage", async (stackName: unknown, serviceName: unknown, callback) => {
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
                // `df -PB1 /data` → POSIX output in bytes for the /data
                // mount inside the container (the itzg/minecraft-server
                // world dir). Fail soft if the image lacks df or /data.
                try {
                    const res = await childProcessAsync.spawn(
                        "docker",
                        [ "exec", containerName, "df", "-PB1", "/data" ],
                        { encoding: "utf-8",
                            timeout: 5000 }
                    );
                    const stdout = (res.stdout?.toString() ?? "").trim();
                    const lines = stdout.split("\n");
                    if (lines.length < 2) {
                        callbackResult({ ok: true,
                            disk: null }, callback);
                        return;
                    }
                    const cols = lines[1].split(/\s+/);
                    const total = parseInt(cols[1], 10);
                    const used = parseInt(cols[2], 10);
                    if (!Number.isFinite(total) || !Number.isFinite(used) || total === 0) {
                        callbackResult({ ok: true,
                            disk: null }, callback);
                        return;
                    }
                    callbackResult({ ok: true,
                        disk: { used,
                            total,
                            usedPercent: (used / total) * 100 } }, callback);
                } catch (e) {
                    callbackResult({ ok: true,
                        disk: null }, callback);
                }
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
