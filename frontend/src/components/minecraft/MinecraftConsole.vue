<template>
    <div class="mc-console">
        <div class="mc-main-row">
            <!-- Left: status pills + terminal + command input -->
            <div class="mc-terminal-col">
                <div class="mc-status-pills">
                    <span class="mc-pill mc-pill-status" :class="isRunning ? 'is-online' : 'is-offline'">
                        <span class="mc-status-dot"></span>
                        {{ isRunning ? "Online" : "Offline" }}
                    </span>
                    <span class="mc-pill">
                        <span class="mc-pill-label">Address</span>
                        <span class="mc-pill-value mc-pill-mono">{{ serverAddress }}</span>
                    </span>
                    <span class="mc-pill">
                        <span class="mc-pill-label">Uptime</span>
                        <span class="mc-pill-value">{{ uptimeText }}</span>
                    </span>
                    <span class="mc-pill">
                        <span class="mc-pill-label">Players</span>
                        <span class="mc-pill-value">{{ playersDisplay }}</span>
                    </span>
                    <span class="mc-pill">
                        <span class="mc-pill-label">Version</span>
                        <span class="mc-pill-value mc-pill-mono" :title="versionDisplay">{{ versionDisplay }}</span>
                    </span>
                </div>

                <div class="mc-terminal-wrap">
                    <Terminal
                        v-if="terminalName"
                        ref="mcTerminal"
                        :name="terminalName"
                        :endpoint="endpoint"
                        mode="displayOnly"
                        style="height: 100%;"
                    />
                    <div v-else class="mc-terminal-offline">
                        <span v-if="attaching">
                            <font-awesome-icon icon="spinner" spin class="me-1" />
                            Connecting to server console...
                        </span>
                        <span v-else>Server is offline</span>
                    </div>
                </div>

                <div class="mc-cmd-input mt-2">
                    <div class="input-group">
                        <span class="input-group-text mc-cmd-prompt">&gt;</span>
                        <input
                            v-model="cmdInput"
                            type="text"
                            class="form-control mc-cmd-field"
                            placeholder="Enter command..."
                            :disabled="!terminalName"
                            @input="resetHistoryNav"
                            @keydown.up.prevent="historyPrev"
                            @keydown.down.prevent="historyNext"
                            @keyup.enter="sendCommand"
                        />
                        <button class="btn btn-primary" :disabled="!terminalName || !cmdInput" @click="sendCommand">
                            Send
                        </button>
                    </div>
                </div>
            </div>

            <!-- Right: charts -->
            <div class="mc-charts-col">
                <MiniChart
                    label="Tick Performance"
                    :datasets="tickDatasets"
                    :axes="tickAxes"
                />
                <MiniChart
                    label="CPU"
                    :datasets="cpuDatasets"
                    unit="%"
                    :max-y="100"
                    :allow-grow-above-max="true"
                    :secondary-sub-value="cpuSubValue"
                />
                <MiniChart
                    label="Memory"
                    :datasets="memDatasets"
                    unit="%"
                    :max-y="100"
                    :sub-value="memSubValue"
                    :secondary-sub-value="memSecondarySubValue"
                />
                <MiniChart
                    label="Network"
                    :datasets="netDatasets"
                    unit="auto-bytes"
                />
            </div>
        </div>
    </div>
</template>

<script>
import Terminal from "../Terminal.vue";
import MiniChart from "./MiniChart.vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { RUNNING } from "../../../../common/util-common";
import { readResourceLimits, readJvmMemory } from "./mcCompose";

const RCON_POLL_MS = 5000;
const HISTORY = 60;
const CMD_HISTORY_LIMIT = 200;

function formatUptime(startedAt) {
    if (!startedAt) {
        return "—";
    }
    const start = new Date(startedAt).getTime();
    if (!start || Number.isNaN(start)) {
        return "—";
    }
    let secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const days = Math.floor(secs / 86400);
    secs -= days * 86400;
    const hours = Math.floor(secs / 3600);
    secs -= hours * 3600;
    const mins = Math.floor(secs / 60);
    secs -= mins * 60;
    if (days > 0) {
        return `${days}d ${hours}h ${mins}m`;
    }
    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    if (mins > 0) {
        return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
}

function parsePercent(str) {
    if (!str) {
        return 0;
    }
    return parseFloat(str.replace("%", "")) || 0;
}

function parseBytes(str) {
    if (!str) {
        return 0;
    }
    const units = { B: 1,
        kB: 1e3,
        KB: 1e3,
        MB: 1e6,
        MiB: 1048576,
        GB: 1e9,
        GiB: 1073741824,
        TB: 1e12 };
    const m = str.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!m) {
        return 0;
    }
    const val = parseFloat(m[1]);
    const unit = m[2];
    return val * (units[unit] || 1);
}

function parseMemPercent(memUsage) {
    if (!memUsage) {
        return 0;
    }
    const parts = memUsage.split(" / ");
    if (parts.length !== 2) {
        return 0;
    }
    const used = parseBytes(parts[0]);
    const total = parseBytes(parts[1]);
    if (total === 0) {
        return 0;
    }
    return (used / total) * 100;
}

function parseNetIO(str) {
    if (!str) {
        return { rx: 0,
            tx: 0 };
    }
    const parts = str.split(" / ");
    if (parts.length !== 2) {
        return { rx: 0,
            tx: 0 };
    }
    return { rx: parseBytes(parts[0]),
        tx: parseBytes(parts[1]) };
}

// Strip Minecraft color codes, log prefixes, and Paper's clock-face glyph.
function cleanLine(line) {
    return line
        .replace(/§./g, "")
        .replace(/^\[\d{1,2}:\d{2}:\d{2}\s*[A-Z]+\]:\s*/i, "")
        .replace(/^[◴◷◶◵*]\s*/u, "")
        .trim();
}

function eachLine(stdout) {
    if (!stdout) {
        return [];
    }
    return stdout.split(/\r?\n/).map(cleanLine).filter(l => l.length > 0);
}

// Paper/Purpur: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"
function parseTps(stdout) {
    for (const line of eachLine(stdout)) {
        const m = line.match(/TPS from[^:]*:\s*\*?(\d+(?:\.\d+)?)/i);
        if (m) {
            return parseFloat(m[1]);
        }
    }
    return null;
}

// Paper: "Server tick times (avg/min/max) from last 5s, 10s, 1m:"
//        "0.3/0.1/1.2, 0.4/0.1/3.8, 0.9/0.1/39.4"
function parseMspt(stdout) {
    for (const line of eachLine(stdout)) {
        const m = line.match(/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
        if (m) {
            return parseFloat(m[1]);
        }
    }
    return null;
}

// "There are 2 of a max of 20 players online: foo, bar" or
// "There are 2/20 players online: foo, bar".
function parsePlayers(stdout) {
    for (const line of eachLine(stdout)) {
        const m = line.match(/There are (\d+)(?:\/| of a max of )(\d+)/i);
        if (m) {
            return { current: parseInt(m[1], 10),
                max: parseInt(m[2], 10) };
        }
    }
    return null;
}

// `minecraft:version` reply (vanilla command, multi-line key=value list):
//   Server version info:
//     id = 26.1.2
//     name = ...
//     ...
function parseVersion(stdout) {
    for (const line of eachLine(stdout)) {
        const m = line.match(/^id\s*=\s*(.+)$/i);
        if (m) {
            return m[1].trim();
        }
    }
    return null;
}

export default {
    components: { Terminal,
        MiniChart,
        FontAwesomeIcon },

    props: {
        endpoint: { type: String,
            required: true },
        stackName: { type: String,
            required: true },
        serviceName: { type: String,
            required: true },
        status: { type: Number,
            default: 0 },
        dockerStats: { type: Object,
            default: () => ({}) },
        jsonConfig: { type: Object,
            default: () => ({}) },
        pollIntervalMs: { type: Number,
            default: 5000 },
    },

    data() {
        return {
            terminalName: "",
            attaching: false,
            reattachTimer: null,
            cmdInput: "",
            cmdHistory: [],
            cmdHistoryIndex: -1,
            cmdDraft: "",
            startedAt: "",
            uptimeTick: 0,
            inspectTimer: null,
            uptimeTimer: null,
            cpuHistory: Array(HISTORY).fill(0),
            memHistory: Array(HISTORY).fill(0),
            netRxHistory: Array(HISTORY).fill(0),
            netTxHistory: Array(HISTORY).fill(0),
            tpsHistory: Array(HISTORY).fill(0),
            msptHistory: Array(HISTORY).fill(0),
            prevNetRx: null,
            prevNetTx: null,
            // RCON polling state (lifted up from the old StatsCard).
            rconTimer: null,
            rconInFlight: false,
            tps: null,
            mspt: null,
            players: null,
            version: null,
        };
    },

    computed: {
        isRunning() {
            return this.status === RUNNING;
        },

        resourceLimits() {
            return readResourceLimits(this.jsonConfig, this.serviceName);
        },

        jvmMemory() {
            return readJvmMemory(this.jsonConfig, this.serviceName);
        },

        cmdHistoryKey() {
            return `mc-cmd-history-${this.stackName}-${this.serviceName}`;
        },

        uptimeText() {
            // eslint-disable-next-line no-unused-expressions
            this.uptimeTick;
            if (!this.isRunning) {
                return "—";
            }
            return formatUptime(this.startedAt);
        },

        serverAddress() {
            const services = this.jsonConfig?.services || {};
            const svc = services[this.serviceName];
            if (!svc?.ports?.length) {
                return "—";
            }
            const portEntry = svc.ports[0];
            const portStr = typeof portEntry === "string" ? portEntry : String(portEntry.target || portEntry.published || portEntry);
            const hostPort = portStr.split(":").pop()?.split("/")[0] || portStr;
            return `${window.location.hostname}:${hostPort}`;
        },

        playersDisplay() {
            if (!this.players) {
                return "—";
            }
            return `${this.players.current} / ${this.players.max}`;
        },

        versionDisplay() {
            return this.version || "—";
        },

        mcStats() {
            return Object.values(this.dockerStats).find(s => {
                const name = s.Name || "";
                return name.toLowerCase().includes(this.stackName.toLowerCase());
            }) || null;
        },

        cpuDatasets() {
            return [{ label: "CPU",
                data: this.cpuHistory,
                color: "#74c2ff" }];
        },

        memDatasets() {
            return [{ label: "Memory",
                data: this.memHistory,
                color: "#86e6a9" }];
        },

        memSubValue() {
            if (!this.mcStats?.MemUsage) {
                return "";
            }
            const parts = this.mcStats.MemUsage.split(" / ");
            if (parts.length !== 2) {
                return "";
            }
            const used = parseBytes(parts[0]) / 1048576;
            const total = parseBytes(parts[1]) / 1048576;
            return `${used.toFixed(0)} / ${total.toFixed(0)} MiB`;
        },

        memSecondarySubValue() {
            const parts = [];
            const { initMemory, maxMemory } = this.jvmMemory;
            if (initMemory || maxMemory) {
                const jvm = [];
                if (initMemory) {
                    jvm.push(`Xms ${initMemory}`);
                }
                if (maxMemory) {
                    jvm.push(`Xmx ${maxMemory}`);
                }
                parts.push(jvm.join(" "));
            }
            const lim = this.resourceLimits.memLimit;
            const res = this.resourceLimits.memReservation;
            if (lim || res) {
                const lr = [];
                if (lim) {
                    lr.push(`lim ${lim}`);
                }
                if (res) {
                    lr.push(`res ${res}`);
                }
                parts.push(lr.join(" / "));
            }
            return parts.join("  •  ");
        },

        cpuSubValue() {
            const lim = this.resourceLimits.cpuLimit;
            const res = this.resourceLimits.cpuReservation;
            if (!lim && !res) {
                return "";
            }
            const lr = [];
            if (lim) {
                lr.push(`lim ${lim}`);
            }
            if (res) {
                lr.push(`res ${res}`);
            }
            return lr.join(" / ");
        },

        netDatasets() {
            return [
                { label: "In",
                    data: this.netRxHistory,
                    color: "#74c2ff" },
                { label: "Out",
                    data: this.netTxHistory,
                    color: "#f8a306" },
            ];
        },

        tickDatasets() {
            return [
                { label: "MSPT",
                    data: this.msptHistory,
                    color: "#f8a306",
                    yAxisID: "mspt" },
                { label: "TPS",
                    data: this.tpsHistory,
                    color: "#74c2ff",
                    yAxisID: "tps" },
            ];
        },

        tickAxes() {
            return [
                { id: "mspt",
                    position: "left",
                    maxY: 50,
                    allowGrowAboveMax: true,
                    unit: "ms" },
                { id: "tps",
                    position: "right",
                    maxY: 20,
                    allowGrowAboveMax: false,
                    unit: "" },
            ];
        },
    },

    watch: {
        dockerStats: {
            deep: true,
            handler() {
                this.pushStats();
            },
        },

        isRunning(val) {
            if (val) {
                this.attach();
                this.startUptimePolling();
                this.startRconPolling();
            } else {
                if (this.terminalName) {
                    this.$root.emitAgent(this.endpoint, "minecraftClearHistory", this.terminalName, () => {});
                }
                this.terminalName = "";
                this.attaching = false;
                this.stopUptimePolling();
                this.stopRconPolling();
                this.resetRconStats();
                this.startedAt = "";
            }
        },

        "$root.lastTerminalExit": {
            deep: true,
            handler(val) {
                if (!val || !this.terminalName || val.name !== this.terminalName) {
                    return;
                }
                this.terminalName = "";
                this.attaching = false;
                if (this.reattachTimer) {
                    clearTimeout(this.reattachTimer);
                }
                this.reattachTimer = setTimeout(() => {
                    this.reattachTimer = null;
                    if (this.isRunning) {
                        this.attach();
                    }
                }, 1500);
            },
        },
    },

    mounted() {
        this.loadCmdHistory();
        if (this.isRunning) {
            this.attach();
            this.startUptimePolling();
            this.startRconPolling();
        }
    },

    beforeUnmount() {
        if (this.reattachTimer) {
            clearTimeout(this.reattachTimer);
            this.reattachTimer = null;
        }
        this.stopUptimePolling();
        this.stopRconPolling();
        if (this.terminalName) {
            this.$root.emitAgent(this.endpoint, "leaveCombinedTerminal", this.stackName, () => {});
        }
    },

    methods: {
        attach() {
            if (this.terminalName || this.attaching) {
                return;
            }
            this.attaching = true;
            this.$root.emitAgent(this.endpoint, "minecraftAttach", this.stackName, this.serviceName, (res) => {
                this.attaching = false;
                if (res.ok) {
                    this.terminalName = res.terminalName;
                    this.$nextTick(() => {
                        const name = this.terminalName;
                        if (!name) {
                            return;
                        }
                        this.$root.emitAgent(this.endpoint, "minecraftRequestHistory", name, () => {});
                    });
                } else {
                    this.$root.toastError(res.msg || "Failed to connect to server console");
                }
            });
        },

        startUptimePolling() {
            this.stopUptimePolling();
            this.fetchUptime();
            this.inspectTimer = setInterval(() => this.fetchUptime(), 30000);
            this.uptimeTimer = setInterval(() => {
                this.uptimeTick = (this.uptimeTick + 1) % 1_000_000;
            }, 1000);
        },

        stopUptimePolling() {
            if (this.inspectTimer) {
                clearInterval(this.inspectTimer);
                this.inspectTimer = null;
            }
            if (this.uptimeTimer) {
                clearInterval(this.uptimeTimer);
                this.uptimeTimer = null;
            }
        },

        fetchUptime() {
            if (!this.isRunning || !this.serviceName) {
                return;
            }
            this.$root.emitAgent(this.endpoint, "minecraftInspect", this.stackName, this.serviceName, (res) => {
                if (res && res.ok) {
                    this.startedAt = res.startedAt || "";
                }
            });
        },

        startRconPolling() {
            this.stopRconPolling();
            this.pollRcon();
            this.rconTimer = setInterval(() => this.pollRcon(), RCON_POLL_MS);
        },

        stopRconPolling() {
            if (this.rconTimer) {
                clearInterval(this.rconTimer);
                this.rconTimer = null;
            }
        },

        resetRconStats() {
            this.tps = null;
            this.mspt = null;
            this.players = null;
            this.version = null;
            this.tpsHistory = Array(HISTORY).fill(0);
            this.msptHistory = Array(HISTORY).fill(0);
        },

        rcon(command) {
            return new Promise((resolve) => {
                this.$root.emitAgent(this.endpoint, "minecraftRconExec", this.stackName, this.serviceName, command, (res) => {
                    resolve(res || { ok: false });
                });
            });
        },

        pollRcon() {
            if (this.rconInFlight || !this.isRunning) {
                return;
            }
            this.rconInFlight = true;
            // Sequential by design — the backend shells out to docker exec
            // each call; four parallel calls just thrash dockerd.
            (async () => {
                try {
                    const tpsRes = await this.rcon("tps");
                    if (!tpsRes.ok) {
                        // RCON not reachable — bail until next tick.
                        return;
                    }
                    const tps = parseTps(tpsRes.stdout);
                    this.tps = tps;
                    this.tpsHistory = [ ...this.tpsHistory.slice(1), tps == null ? 0 : tps ];

                    const msptRes = await this.rcon("mspt");
                    const mspt = msptRes.ok ? parseMspt(msptRes.stdout) : null;
                    this.mspt = mspt;
                    this.msptHistory = [ ...this.msptHistory.slice(1), mspt == null ? 0 : mspt ];

                    const listRes = await this.rcon("minecraft:list");
                    this.players = listRes.ok ? parsePlayers(listRes.stdout) : null;

                    const versionRes = await this.rcon("minecraft:version");
                    if (versionRes.ok) {
                        const v = parseVersion(versionRes.stdout);
                        if (v) {
                            this.version = v;
                        }
                    }
                } finally {
                    this.rconInFlight = false;
                }
            })();
        },

        loadCmdHistory() {
            try {
                const raw = localStorage.getItem(this.cmdHistoryKey);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        this.cmdHistory = parsed.slice(-CMD_HISTORY_LIMIT);
                    }
                }
            } catch (e) {
                // ignore — corrupt storage just resets history.
            }
        },

        saveCmdHistory() {
            try {
                localStorage.setItem(this.cmdHistoryKey, JSON.stringify(this.cmdHistory));
            } catch (e) {
                // localStorage full or disabled — non-fatal.
            }
        },

        sendCommand() {
            if (!this.cmdInput || !this.terminalName) {
                return;
            }
            const raw = this.cmdInput;
            const cmd = raw + "\n";
            this.cmdInput = "";
            this.cmdDraft = "";
            this.cmdHistoryIndex = -1;
            const trimmed = raw.trim();
            if (trimmed && this.cmdHistory[this.cmdHistory.length - 1] !== trimmed) {
                this.cmdHistory = [ ...this.cmdHistory, trimmed ].slice(-CMD_HISTORY_LIMIT);
                this.saveCmdHistory();
            }
            this.$root.emitAgent(this.endpoint, "terminalInput", this.terminalName, cmd, (res) => {
                if (res && !res.ok) {
                    this.$root.toastError(res.msg || "Failed to send command");
                }
            });
        },

        historyPrev() {
            if (this.cmdHistory.length === 0) {
                return;
            }
            if (this.cmdHistoryIndex === -1) {
                this.cmdDraft = this.cmdInput;
                this.cmdHistoryIndex = this.cmdHistory.length - 1;
            } else if (this.cmdHistoryIndex > 0) {
                this.cmdHistoryIndex -= 1;
            }
            this.cmdInput = this.cmdHistory[this.cmdHistoryIndex];
        },

        historyNext() {
            if (this.cmdHistoryIndex === -1) {
                return;
            }
            if (this.cmdHistoryIndex < this.cmdHistory.length - 1) {
                this.cmdHistoryIndex += 1;
                this.cmdInput = this.cmdHistory[this.cmdHistoryIndex];
            } else {
                this.cmdHistoryIndex = -1;
                this.cmdInput = this.cmdDraft;
            }
        },

        resetHistoryNav(event) {
            // Native input events from typing/pasting; arrow-key navigation
            // doesn't fire @input so it survives. Anything else resets the
            // browsing cursor so the next Up starts from the latest entry.
            if (event && event.isComposing) {
                return;
            }
            this.cmdHistoryIndex = -1;
        },

        pushStats() {
            if (!this.mcStats) {
                return;
            }

            const cpu = parsePercent(this.mcStats.CPUPerc);
            const mem = parseMemPercent(this.mcStats.MemUsage);
            const net = parseNetIO(this.mcStats.NetIO);

            this.cpuHistory = [ ...this.cpuHistory.slice(1), cpu ];
            this.memHistory = [ ...this.memHistory.slice(1), mem ];

            const intervalSec = Math.max(0.001, this.pollIntervalMs / 1000);
            let rxRate = 0;
            let txRate = 0;
            if (this.prevNetRx !== null) {
                rxRate = Math.max(0, (net.rx - this.prevNetRx) / intervalSec / 1024);
                txRate = Math.max(0, (net.tx - this.prevNetTx) / intervalSec / 1024);
            }
            this.prevNetRx = net.rx;
            this.prevNetTx = net.tx;

            this.netRxHistory = [ ...this.netRxHistory.slice(1), rxRate ];
            this.netTxHistory = [ ...this.netTxHistory.slice(1), txRate ];
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-console {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 0;
}

.mc-main-row {
    display: flex;
    gap: 12px;
    flex: 1;
    min-height: 0;
}

.mc-terminal-col {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
}

.mc-status-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
}

.mc-pill {
    background: $dark-header-bg;
    border-radius: 999px;
    padding: 4px 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    line-height: 1.3;
    color: $dark-font-color;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.mc-pill-label {
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
    color: $dark-font-color3;
}

.mc-pill-value {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
}

.mc-pill-mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
}

.mc-pill-status {
    font-weight: 600;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.04em;

    .mc-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #888;
        display: inline-block;
    }

    &.is-online .mc-status-dot {
        background: #4ade80;
        box-shadow: 0 0 6px rgba(74, 222, 128, 0.6);
    }

    &.is-offline {
        color: $dark-font-color3;

        .mc-status-dot {
            background: #ef4444;
        }
    }
}

.mc-terminal-wrap {
    flex: 1;
    min-height: 0;
    background: #000;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    :deep(.shadow-box) {
        padding: 0;
        background: transparent !important;
        box-shadow: none;
        border-radius: 10px;
        height: 100%;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    :deep(.main-terminal) {
        flex: 1;
        height: 100%;
        min-height: 0;
    }
}

.mc-terminal-offline {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: $dark-font-color3;
    font-size: 14px;
}

.mc-cmd-input {
    .mc-cmd-prompt {
        background: $dark-header-bg;
        border-color: $dark-border-color;
        color: $primary;
        font-family: 'JetBrains Mono', monospace;
        font-weight: bold;
    }

    .mc-cmd-field {
        background: $dark-bg;
        border-color: $dark-border-color;
        color: $dark-font-color;
        font-family: 'JetBrains Mono', monospace;

        &:focus {
            background: $dark-bg;
            color: $dark-font-color;
            border-color: $primary;
            box-shadow: 0 0 0 2px rgba(116, 194, 255, 0.2);
        }
    }
}

.mc-charts-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 25%;
    max-width: 420px;
    flex-shrink: 0;
    min-height: 0;

    > :deep(.mini-chart-wrapper) {
        flex: 1 1 0;
        min-height: 0;
    }
}

@media (max-width: $bp-mobile) {
    .mc-main-row {
        flex-direction: column;
        flex: 0 0 auto;
        min-height: 0;
    }

    .mc-terminal-col {
        width: 100%;
        flex: 0 0 auto;
    }

    .mc-terminal-wrap {
        min-height: 320px;
        height: 320px;
    }

    .mc-charts-col {
        width: 100%;
        max-width: none;
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 0 0 auto;

        > :deep(.mini-chart-wrapper) {
            flex: 0 0 auto;
            height: 130px;
        }
    }
}
</style>
