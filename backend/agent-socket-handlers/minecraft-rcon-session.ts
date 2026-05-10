import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { log } from "../log";

// One persistent `docker exec -i <container> rcon-cli` per stack/service.
// The interactive rcon-cli holds a single TCP connection to the in-container
// RCON port for the lifetime of the process, so the Minecraft server only
// logs *one* "Thread RCON Client started / shutting down" pair per session
// instead of one per command (which was the source of the web-console spam
// when polling at 5s × 4 commands).
//
// Protocol detail: rcon-cli interactive prints `> ` (prompt + space) before
// each read. After we write `<cmd>\n`, the reply lands as `<reply>\n> `.
// We clear the read buffer before each write so a residual prompt from the
// previous turn (or the initial spawn) doesn't confuse the matcher.

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const PROMPT_RE = /^([\s\S]*?)\n?>\s*$/;

interface Waiter {
    resolve: (reply: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

export interface RconResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number;
}

export class RconSession {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private buf: string = "";
    private stderrBuf: string = "";
    private waiter: Waiter | null = null;
    private mutex: Promise<void> = Promise.resolve();
    private idleTimer: NodeJS.Timeout | null = null;
    private readonly idleMs: number;

    constructor(private readonly containerName: string, idleMs: number = 60000) {
        this.idleMs = idleMs;
    }

    async exec(command: string, timeoutMs: number = 5000): Promise<RconResult> {
        // Serialize all callers through a chained promise — at most one
        // command in flight per session at a time.
        const slot = this.mutex.then(() => this.execOne(command, timeoutMs));
        this.mutex = slot.then(() => undefined, () => undefined);
        return slot;
    }

    close(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.proc) {
            try {
                this.proc.stdin.end();
            } catch (_) { /* ignore */ }
            this.proc = null;
        }
    }

    private async execOne(command: string, timeoutMs: number): Promise<RconResult> {
        this.bumpIdle();
        try {
            await this.ensureSpawned();
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { ok: false,
                stdout: "",
                stderr: err,
                code: 1 };
        }
        return new Promise<RconResult>((resolve) => {
            this.buf = "";
            this.stderrBuf = "";
            this.waiter = {
                resolve: (reply) => resolve({ ok: true,
                    stdout: reply,
                    stderr: "",
                    code: 0 }),
                reject: (err) => resolve({ ok: false,
                    stdout: "",
                    stderr: err.message,
                    code: 1 }),
                timer: setTimeout(() => {
                    if (!this.waiter) {
                        return;
                    }
                    this.waiter = null;
                    this.kill();
                    resolve({ ok: false,
                        stdout: "",
                        stderr: "rcon-cli timeout",
                        code: 124 });
                }, timeoutMs),
            };
            try {
                this.proc!.stdin.write(command + "\n");
            } catch (e) {
                this.failWaiter(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    private ensureSpawned(): Promise<void> {
        if (this.proc) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            let proc: ChildProcessWithoutNullStreams;
            try {
                proc = spawn("docker", [ "exec", "-i", this.containerName, "rcon-cli" ], {
                    stdio: [ "pipe", "pipe", "pipe" ],
                });
            } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
                return;
            }
            this.proc = proc;
            this.buf = "";
            this.stderrBuf = "";
            proc.stdout.setEncoding("utf-8");
            proc.stderr.setEncoding("utf-8");
            proc.stdout.on("data", this.onStdout);
            proc.stderr.on("data", this.onStderr);
            proc.on("error", (err) => {
                this.handleProcExit(err);
            });
            proc.on("exit", () => {
                this.handleProcExit(this.stderrBuf
                    ? new Error(this.stderrBuf.trim() || "rcon-cli exited")
                    : new Error("rcon-cli exited"));
            });
            // Don't wait for the initial "> " prompt here; execOne clears
            // the buffer right before each write, so any pre-command
            // prompts are discarded harmlessly.
            resolve();
        });
    }

    private onStdout = (chunk: string | Buffer) => {
        this.buf += chunk.toString();
        this.checkPrompt();
    };

    private onStderr = (chunk: string | Buffer) => {
        this.stderrBuf += chunk.toString();
    };

    private checkPrompt() {
        if (!this.waiter) {
            return;
        }
        const stripped = this.buf.replace(ANSI_RE, "");
        const m = stripped.match(PROMPT_RE);
        if (!m) {
            return;
        }
        const reply = m[1].replace(/^[\r\n]+|[\r\n]+$/g, "");
        const w = this.waiter;
        this.waiter = null;
        this.buf = "";
        clearTimeout(w.timer);
        w.resolve(reply);
    }

    private failWaiter(err: Error) {
        if (!this.waiter) {
            return;
        }
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.reject(err);
    }

    private handleProcExit(err: Error) {
        this.proc = null;
        this.failWaiter(err);
    }

    private kill() {
        if (this.proc) {
            try {
                this.proc.kill("SIGTERM");
            } catch (_) { /* ignore */ }
            this.proc = null;
        }
    }

    private bumpIdle() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => {
            log.debug("RconSession", `Idle close for ${this.containerName}`);
            this.close();
        }, this.idleMs);
    }
}

// Keyed by "<endpoint>::<stackName>::<serviceName>". Each container gets
// at most one persistent session shared across all callers on this agent.
const sessions: Map<string, { session: RconSession, containerName: string }> = new Map();

export function getRconSession(key: string, containerName: string): RconSession {
    const existing = sessions.get(key);
    if (existing && existing.containerName === containerName) {
        return existing.session;
    }
    if (existing) {
        existing.session.close();
    }
    const session = new RconSession(containerName);
    sessions.set(key, { session,
        containerName });
    return session;
}
