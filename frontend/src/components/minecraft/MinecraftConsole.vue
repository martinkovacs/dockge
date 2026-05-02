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
                <div class="mc-info-block mb-2">
                    <div class="mc-info-label">Status</div>
                    <div class="mc-info-value">
                        <span :class="statusClass">{{ statusText }}</span>
                    </div>
                    <div class="mc-info-label mt-2">Address</div>
                    <div class="mc-info-value address-val">{{ serverAddress }}</div>
                </div>
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
                    unit="KB/s"
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
            cmdInput: "",
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

        statusText() {
            return this.isRunning ? "Online" : "Offline";
        },

        statusClass() {
            return this.isRunning ? "text-success fw-bold" : "text-danger fw-bold";
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
            } else {
                if (this.terminalName) {
                    this.$root.emitAgent(this.endpoint, "leaveCombinedTerminal", this.stackName, () => {});
                }
                this.terminalName = "";
                this.attaching = false;
            }
        },
    },

    mounted() {
        if (this.isRunning) {
            this.attach();
        }
    },

    beforeUnmount() {
        // Leave the terminal so the PTY can be garbage collected
        if (this.terminalName) {
            this.$root.emitAgent(this.endpoint, "leaveCombinedTerminal", this.stackName, () => {});
        }
    },

    methods: {
        attach() {
            if (this.attaching) {
                return;
            }
            this.attaching = true;
            this.$root.emitAgent(this.endpoint, "minecraftAttach", this.stackName, this.serviceName, (res) => {
                this.attaching = false;
                if (res.ok) {
                    this.terminalName = res.terminalName;
                } else {
                    this.$root.toastError(res.msg || "Failed to connect to server console");
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
    background: #000 !important;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
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

    @media (max-width: 900px) {
        width: 100%;
        max-width: none;
        flex-direction: row;
        flex-wrap: wrap;

        > * {
            flex: 1 1 calc(50% - 5px);
        }
    }
}
</style>
