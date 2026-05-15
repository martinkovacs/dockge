<template>
    <div class="mc-console">
        <!-- Main content: terminal left, info+charts right -->
        <div class="mc-main-row">
            <!-- Left: terminal + command input -->
            <div class="mc-terminal-col">
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
                <!-- Command input -->
                <div class="mc-cmd-input mt-2">
                    <div class="input-group">
                        <span class="input-group-text mc-cmd-prompt">&gt;</span>
                        <input
                            v-model="cmdInput"
                            type="text"
                            class="form-control mc-cmd-field"
                            placeholder="Enter command..."
                            :disabled="!terminalName"
                            @keyup.enter="sendCommand"
                        />
                        <button class="btn btn-primary" :disabled="!terminalName || !cmdInput" @click="sendCommand">
                            Send
                        </button>
                    </div>
                </div>
            </div>

            <!-- Right: status, address, charts -->
            <div class="mc-charts-col">
                <div class="mc-info-block">
                    <div class="mc-info-col">
                        <div class="mc-info-label">Address</div>
                        <div class="mc-info-value address-val">{{ serverAddress }}</div>
                        <div class="mc-info-label mt-2">Uptime</div>
                        <div class="mc-info-value">{{ uptimeText }}</div>
                    </div>
                    <div v-if="limitSections.length" class="mc-info-col mc-info-col-limits">
                        <div
                            v-for="section in limitSections"
                            :key="section.title"
                            class="mc-limits-section"
                        >
                            <div class="mc-limits-section-title">{{ section.title }}</div>
                            <div class="mc-limits-section-row">
                                <div
                                    v-for="pair in section.pairs"
                                    :key="pair.label"
                                    class="mc-limits-pair"
                                >
                                    <span class="mc-limits-section-label">{{ pair.label }}</span>
                                    <span class="mc-limits-section-value">{{ pair.value }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <MinecraftStatsCard
                    :endpoint="endpoint"
                    :stack-name="stackName"
                    :service-name="serviceName"
                    :status="status"
                />
                <MiniChart
                    label="CPU"
                    :datasets="cpuDatasets"
                    unit="%"
                    :max-y="100"
                    :allow-grow-above-max="true"
                />
                <MiniChart
                    label="Memory"
                    :datasets="memDatasets"
                    unit="%"
                    :max-y="100"
                    :sub-value="memSubValue"
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
import MinecraftStatsCard from "./MinecraftStatsCard.vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { RUNNING } from "../../../../common/util-common";
import { readResourceLimits, readJvmMemory } from "./mcCompose";

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

const HISTORY = 60;

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

export default {
    components: { Terminal,
        MiniChart,
        MinecraftStatsCard,
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
            startedAt: "",
            uptimeTick: 0,
            inspectTimer: null,
            uptimeTimer: null,
            cpuHistory: Array(HISTORY).fill(0),
            memHistory: Array(HISTORY).fill(0),
            netRxHistory: Array(HISTORY).fill(0),
            netTxHistory: Array(HISTORY).fill(0),
            prevNetRx: null,
            prevNetTx: null,
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

        limitSections() {
            const sections = [];
            const jvm = [];
            if (this.jvmMemory.initMemory) {
                jvm.push({ label: "Xms",
                    value: this.jvmMemory.initMemory });
            }
            if (this.jvmMemory.maxMemory) {
                jvm.push({ label: "Xmx",
                    value: this.jvmMemory.maxMemory });
            }
            if (jvm.length) {
                sections.push({ title: "JVM",
                    pairs: jvm });
            }

            const limits = [];
            if (this.resourceLimits.cpuLimit) {
                limits.push({ label: "CPU",
                    value: this.resourceLimits.cpuLimit });
            }
            if (this.resourceLimits.memLimit) {
                limits.push({ label: "Mem",
                    value: this.resourceLimits.memLimit });
            }
            if (limits.length) {
                sections.push({ title: "Limits",
                    pairs: limits });
            }

            const reservations = [];
            if (this.resourceLimits.cpuReservation) {
                reservations.push({ label: "CPU",
                    value: this.resourceLimits.cpuReservation });
            }
            if (this.resourceLimits.memReservation) {
                reservations.push({ label: "Mem",
                    value: this.resourceLimits.memReservation });
            }
            if (reservations.length) {
                sections.push({ title: "Reservations",
                    pairs: reservations });
            }

            return sections;
        },

        uptimeText() {
            // Re-evaluated on uptimeTick changes so the ticker re-renders.
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

        mcStats() {
            return Object.values(this.dockerStats).find(s => {
                const name = s.Name || "";
                return name.toLowerCase().includes(this.stackName.toLowerCase());
            }) || null;
        },

        cpuText() {
            return this.mcStats?.CPUPerc || "—";
        },

        memText() {
            if (!this.mcStats?.MemUsage) {
                return "—";
            }
            const parts = this.mcStats.MemUsage.split(" / ");
            const pct = parseMemPercent(this.mcStats.MemUsage).toFixed(2);
            return `${pct}% (${parts[0]} / ${parts[1]})`;
        },

        diskText() {
            return this.mcStats?.BlockIO || "—";
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
            return `${used.toFixed(2)} MiB / ${total.toFixed(2)} MiB`;
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
            } else {
                if (this.terminalName) {
                    // Tell the backend to drop the follower + history buffer
                    // for this stack — fresh start next time the user runs it.
                    this.$root.emitAgent(this.endpoint, "minecraftClearHistory", this.terminalName, () => {});
                }
                this.terminalName = "";
                this.attaching = false;
                this.stopUptimePolling();
                this.startedAt = "";
            }
        },

        // When the docker attach pty exits (typical case: container restart
        // killing the attached process), the backend emits `terminalExit` and
        // the entry is removed from its terminalMap. Clear our local
        // reference so a fresh attach can run; if the server is still
        // marked as running, reconnect after a short delay (the new
        // container needs a moment to come up).
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
        if (this.isRunning) {
            this.attach();
            this.startUptimePolling();
        }
    },

    beforeUnmount() {
        if (this.reattachTimer) {
            clearTimeout(this.reattachTimer);
            this.reattachTimer = null;
        }
        this.stopUptimePolling();
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
                    // Wait for the <Terminal> child to mount and bind itself
                    // into terminalMap before the server replays history.
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
            // Re-fetch the container's StartedAt every 30s so we catch
            // restarts. The displayed value advances every second via
            // uptimeTimer below.
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

        sendCommand() {
            if (!this.cmdInput || !this.terminalName) {
                return;
            }
            const cmd = this.cmdInput + "\n";
            this.cmdInput = "";
            this.$root.emitAgent(this.endpoint, "terminalInput", this.terminalName, cmd, (res) => {
                if (res && !res.ok) {
                    this.$root.toastError(res.msg || "Failed to send command");
                }
            });
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

.mc-info-block {
    background: $dark-header-bg;
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    flex-direction: row;
    gap: 14px;
    align-items: flex-start;
}

.mc-info-col {
    flex: 1 1 0;
    min-width: 0;
}

.mc-info-col-limits {
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    padding-left: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.mc-limits-section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: $dark-font-color3;
    margin-bottom: 1px;
    line-height: 1.2;
}

.mc-limits-section-row {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px 12px;
}

.mc-limits-pair {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    flex: 1 1 0;
}

.mc-limits-section-label {
    font-size: 11px;
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.3;
}

.mc-limits-section-value {
    font-size: 12px;
    font-weight: 600;
    color: $dark-font-color;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

@media (max-width: 1100px) and (min-width: 769px) {
    .mc-info-col-limits {
        display: none;
    }
}

.mc-info-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: $dark-font-color3;
    margin-bottom: 2px;
}

.mc-info-value {
    font-size: 14px;
    font-weight: 600;
    color: $dark-font-color;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &.address-val {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
    }
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

.mc-terminal-wrap {
    flex: 1;
    min-height: 0;
    background: #000;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    // The shared Terminal component wraps itself in .shadow-box (10px padding
    // + dark-bg in dark mode). For the Minecraft console we want the xterm
    // flush to our rounded black wrap, so neutralise it.
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
        // Drop the parent's flex:1 + min-height:0 contract on mobile —
        // when the column is stacked, we want it to grow to fit the
        // terminal AND the full height of every chart, not split a
        // fixed viewport between them (which collapses chart canvases).
        flex: 0 0 auto;
        min-height: 0;
    }

    .mc-terminal-col {
        width: 100%;
        // Terminal still gets a fixed-ish minimum so the xterm is usable.
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

        // Give each chart a fixed height on mobile so they don't fight
        // the terminal for vertical space (which previously zero-sized
        // the canvases).
        > :deep(.mini-chart-wrapper) {
            flex: 0 0 auto;
            height: 130px;
        }
    }
}
</style>
