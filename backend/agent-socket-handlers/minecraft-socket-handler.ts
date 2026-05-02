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
                    // Get container name from docker compose ps
                    let containerName: string | null = null;
                    try {
                        const res = await childProcessAsync.spawn("docker", [ "compose", "ps", "--format", "json" ], {
                            cwd: stack.path,
                            encoding: "utf-8",
                        });
                        const stdout = res.stdout?.toString() ?? "";
                        for (const line of stdout.split("\n")) {
                            try {
                                const obj = JSON.parse(line);
                                const items = Array.isArray(obj) ? obj : [ obj ];
                                for (const item of items) {
                                    if (item.Service === serviceName || serviceName === "") {
                                        containerName = item.Name;
                                        break;
                                    }
                                }
                                if (containerName) {
                                    break;
                                }
                            } catch (_) { /* skip */ }
                        }
                    } catch (e) {
                        log.warn("minecraftAttach", "Failed to get container name: " + e);
                    }

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
                const composePath = path.join(stack.path, "compose.yaml");
                let actualPath = composePath;
                try {
                    await fsAsync.access(composePath);
                } catch {
                    actualPath = path.join(stack.path, "compose.yml");
                }

                const raw = await fsAsync.readFile(actualPath, "utf-8");
                const doc = YAML.parseDocument(raw);

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
                const setEnvVar = (key: string, value: string | null | undefined) => {
                    const empty = value === null || value === undefined || value === "";
                    let env = svc.get("environment", true) as unknown;

                    if (env instanceof YAML.YAMLSeq) {
                        // Find existing entry "KEY" or "KEY=..."
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

                    // No environment yet — only create when we have a value to set.
                    if (!empty) {
                        const m = new YAML.YAMLMap();
                        m.set(key, value);
                        svc.set("environment", m);
                    }
                };

                setEnvVar("INIT_MEMORY", initMemory || null);
                setEnvVar("MAX_MEMORY", maxMemory || null);

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
