<template>
    <div class="mc-stats-card">
        <div class="mc-stats-title">
            <font-awesome-icon icon="chart-line" class="me-1 text-primary" />
            Server Stats
            <span v-if="!available" class="mc-stats-badge" :title="unavailableReason">
                offline
            </span>
        </div>

        <div class="mc-stats-grid">
            <div class="mc-stat">
                <div class="mc-stat-label">
                    <font-awesome-icon icon="gauge-high" class="me-1" />
                    TPS
                </div>
                <div class="mc-stat-value" :class="tpsClass">{{ tpsDisplay }}</div>
            </div>
            <div class="mc-stat">
                <div class="mc-stat-label">
                    <font-awesome-icon icon="clock" class="me-1" />
                    MSPT
                </div>
                <div class="mc-stat-value" :class="msptClass">{{ msptDisplay }}</div>
            </div>
            <div class="mc-stat">
                <div class="mc-stat-label">
                    <font-awesome-icon icon="users" class="me-1" />
                    Players
                </div>
                <div class="mc-stat-value">{{ playersDisplay }}</div>
            </div>
            <div class="mc-stat">
                <div class="mc-stat-label">
                    <font-awesome-icon icon="tag" class="me-1" />
                    Version
                </div>
                <div class="mc-stat-value mc-stat-version" :title="versionDisplay">{{ versionDisplay }}</div>
            </div>
        </div>

        <div v-if="!available" class="mc-stats-hint">
            {{ unavailableReason || "Waiting for server..." }}
        </div>
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { RUNNING } from "../../../../common/util-common";

const POLL_MS = 5000;

// Parse "TPS from last 1m, 5m, 15m: *20.00, *20.00, *20.00" or
// "§a20.00, §a20.00, §a20.00" — color codes (§x) and asterisks denote
// "max TPS". Strip them and pull the first number.
function parseTps(stdout) {
    if (!stdout) {
        return null;
    }
    const cleaned = stdout.replace(/§./g, "").replace(/\*/g, "");
    const m = cleaned.match(/(\d+\.\d+|\d+)/);
    return m ? parseFloat(m[1]) : null;
}

// Parse "Server tick times (avg/min/max) from last 5s, 10s, 1m:
// §a4.50/§a1.20/§e8.30" — first number is the recent average.
function parseMspt(stdout) {
    if (!stdout) {
        return null;
    }
    const cleaned = stdout.replace(/§./g, "");
    const m = cleaned.match(/(\d+\.\d+|\d+)/);
    return m ? parseFloat(m[1]) : null;
}

// Parse "There are 2 of a max of 20 players online: foo, bar" or
// "There are 2/20 players online: foo, bar".
function parsePlayers(stdout) {
    if (!stdout) {
        return null;
    }
    const cleaned = stdout.replace(/§./g, "");
    const m = cleaned.match(/There are (\d+)(?:\/| of a max of )(\d+)/i);
    if (!m) {
        return null;
    }
    return { current: parseInt(m[1], 10),
        max: parseInt(m[2], 10) };
}

// Parse "This server is running Paper version 1.21.4-..." — keep the
// distribution + version, drop "(Implementing API version ...)".
function parseVersion(stdout) {
    if (!stdout) {
        return null;
    }
    const cleaned = stdout.replace(/§./g, "").trim();
    const m = cleaned.match(/running\s+(.+?)(?:\s*\(|$)/i);
    if (m) {
        return m[1].trim();
    }
    // Fallback: vanilla `version` returns "Checking version, please wait..."
    // and pushes the result via console; otherwise just return first line.
    return cleaned.split("\n")[0].trim() || null;
}

export default {
    components: { FontAwesomeIcon },

    props: {
        endpoint: { type: String,
            required: true },
        stackName: { type: String,
            required: true },
        serviceName: { type: String,
            required: true },
        status: { type: Number,
            default: 0 },
    },

    data() {
        return {
            tps: null,
            mspt: null,
            players: null,
            version: null,
            timer: null,
            inFlight: false,
            // Distinct error reasons so the user can tell "RCON not enabled"
            // from "container down" without us having to inspect output.
            lastError: "",
            available: false,
        };
    },

    computed: {
        isRunning() {
            return this.status === RUNNING;
        },

        tpsDisplay() {
            return this.tps == null ? "—" : this.tps.toFixed(1);
        },

        tpsClass() {
            if (this.tps == null) {
                return "";
            }
            if (this.tps < 15) {
                return "text-danger";
            }
            if (this.tps < 19) {
                return "text-warning";
            }
            return "text-success";
        },

        msptDisplay() {
            return this.mspt == null ? "—" : this.mspt.toFixed(1) + " ms";
        },

        msptClass() {
            if (this.mspt == null) {
                return "";
            }
            if (this.mspt > 50) {
                return "text-danger";
            }
            if (this.mspt > 35) {
                return "text-warning";
            }
            return "text-success";
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

        unavailableReason() {
            if (!this.isRunning) {
                return "Server is offline.";
            }
            if (this.lastError) {
                return this.lastError;
            }
            return "";
        },
    },

    watch: {
        isRunning(val) {
            if (val) {
                this.start();
            } else {
                this.stop();
                this.reset();
            }
        },
    },

    mounted() {
        if (this.isRunning) {
            this.start();
        }
    },

    beforeUnmount() {
        this.stop();
    },

    methods: {
        reset() {
            this.tps = null;
            this.mspt = null;
            this.players = null;
            this.version = null;
            this.available = false;
        },

        start() {
            this.stop();
            this.poll();
            this.timer = setInterval(() => this.poll(), POLL_MS);
        },

        stop() {
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
        },

        rcon(command) {
            return new Promise((resolve) => {
                this.$root.emitAgent(this.endpoint, "minecraftRconExec", this.stackName, this.serviceName, command, (res) => {
                    resolve(res || { ok: false });
                });
            });
        },

        poll() {
            if (this.inFlight || !this.isRunning) {
                return;
            }
            this.inFlight = true;
            // Run sequentially — the backend handler shells out to
            // docker exec each time, four parallel calls just thrash
            // dockerd for no benefit on a 5s cadence.
            (async () => {
                try {
                    const tpsRes = await this.rcon("tps");
                    if (!tpsRes.ok) {
                        // First call failure means RCON itself isn't reachable.
                        // Use stderr if it's informative, otherwise generic.
                        const err = (tpsRes.stderr || "").trim();
                        this.lastError = err.includes("rcon-cli")
                            ? "rcon-cli not available in container."
                            : (err || "Enable ENABLE_RCON=true in Settings to see live stats.");
                        this.available = false;
                        return;
                    }
                    this.available = true;
                    this.lastError = "";
                    const tps = parseTps(tpsRes.stdout);
                    if (tps != null) {
                        this.tps = tps;
                    } else {
                        // Vanilla replies "Unknown command".
                        this.tps = null;
                    }

                    const msptRes = await this.rcon("mspt");
                    this.mspt = msptRes.ok ? parseMspt(msptRes.stdout) : null;

                    const listRes = await this.rcon("list");
                    this.players = listRes.ok ? parsePlayers(listRes.stdout) : null;

                    const versionRes = await this.rcon("version");
                    if (versionRes.ok) {
                        const v = parseVersion(versionRes.stdout);
                        if (v) {
                            this.version = v;
                        }
                    }
                } finally {
                    this.inFlight = false;
                }
            })();
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-stats-card {
    background: $dark-header-bg;
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.mc-stats-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: $dark-font-color3;
    display: flex;
    align-items: center;
    gap: 6px;
}

.mc-stats-badge {
    font-size: 10px;
    background: rgba(220, 53, 69, 0.18);
    color: #ff8b94;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    margin-left: auto;
}

.mc-stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 12px;
}

.mc-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.mc-stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: $dark-font-color3;
}

.mc-stat-value {
    font-size: 14px;
    font-weight: 600;
    color: $dark-font-color;
    font-family: 'JetBrains Mono', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.mc-stat-version {
    font-size: 12px;
}

.mc-stats-hint {
    font-size: 11px;
    color: $dark-font-color3;
    line-height: 1.4;
}
</style>
