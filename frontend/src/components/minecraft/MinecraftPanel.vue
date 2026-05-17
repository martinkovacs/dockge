<template>
    <div class="mc-panel">
        <!-- Tab bar -->
        <ul class="nav nav-tabs mc-tabs mb-3">
            <li class="nav-item">
                <a
                    class="nav-link"
                    :class="{ active: activeTab === 'console' }"
                    href="#"
                    @click.prevent="activeTab = 'console'"
                >
                    <font-awesome-icon icon="terminal" class="me-1" />
                    Console
                </a>
            </li>
            <li class="nav-item">
                <a
                    class="nav-link"
                    :class="{ active: activeTab === 'files' }"
                    href="#"
                    @click.prevent="activeTab = 'files'"
                >
                    <font-awesome-icon icon="folder-open" class="me-1" />
                    Files
                </a>
            </li>
            <li class="nav-item">
                <a
                    class="nav-link"
                    :class="{ active: activeTab === 'bash' }"
                    href="#"
                    @click.prevent="activateBash"
                >
                    <font-awesome-icon icon="terminal" class="me-1" />
                    Bash
                </a>
            </li>
            <li class="nav-item">
                <a
                    class="nav-link"
                    :class="{ active: activeTab === 'limits' }"
                    href="#"
                    @click.prevent="activeTab = 'limits'"
                >
                    <font-awesome-icon icon="gauge-high" class="me-1" />
                    Limits
                </a>
            </li>
            <li class="nav-item">
                <a
                    class="nav-link"
                    :class="{ active: activeTab === 'settings' }"
                    href="#"
                    @click.prevent="activeTab = 'settings'"
                >
                    <font-awesome-icon icon="cog" class="me-1" />
                    Settings
                </a>
            </li>
        </ul>

        <!-- Tab content -->
        <div class="mc-panel-content">
            <MinecraftConsole
                v-show="activeTab === 'console'"
                :endpoint="endpoint"
                :stack-name="stackName"
                :service-name="minecraftServiceName"
                :status="status"
                :docker-stats="dockerStats"
                :json-config="jsonConfig"
                :poll-interval-ms="pollIntervalMs"
            />
            <MinecraftFiles
                v-if="activeTab === 'files'"
                :endpoint="endpoint"
                :stack-name="stackName"
            />
            <div v-if="bashEverActivated" v-show="activeTab === 'bash'" class="mc-bash-pane">
                <div class="mc-bash-toolbar">
                    <button class="btn btn-sm btn-normal" @click="toggleBashShell">
                        {{ bashShell === "bash" ? $t("Switch to sh") : $t("Switch to bash") }}
                    </button>
                </div>
                <Terminal
                    :key="bashShell"
                    class="mc-bash-terminal"
                    mode="interactive"
                    :name="bashTerminalName"
                    :endpoint="endpoint"
                    :stack-name="stackName"
                    :service-name="minecraftServiceName"
                    :shell="bashShell"
                />
            </div>
            <MinecraftLimits
                v-if="activeTab === 'limits'"
                :endpoint="endpoint"
                :stack-name="stackName"
                :service-name="minecraftServiceName"
                :json-config="jsonConfig"
                @saved="$emit('limits-saved')"
            />
            <MinecraftSettings
                v-if="activeTab === 'settings'"
                :endpoint="endpoint"
                :stack-name="stackName"
                :service-name="minecraftServiceName"
                :json-config="jsonConfig"
                @saved="$emit('limits-saved')"
            />
        </div>
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import MinecraftConsole from "./MinecraftConsole.vue";
import MinecraftFiles from "./MinecraftFiles.vue";
import MinecraftLimits from "./MinecraftLimits.vue";
import MinecraftSettings from "./MinecraftSettings.vue";
import Terminal from "../Terminal.vue";
import { getContainerExecTerminalName } from "../../../../common/util-common";

const MINECRAFT_IMAGES = [ "itzg/minecraft-server", "itzg/mc-proxy" ];

export default {
    components: { FontAwesomeIcon,
        MinecraftConsole,
        MinecraftFiles,
        MinecraftLimits,
        MinecraftSettings,
        Terminal },

    props: {
        endpoint: { type: String,
            required: true },
        stackName: { type: String,
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

    emits: [ "limits-saved" ],

    data() {
        return {
            activeTab: "console",
            bashEverActivated: false,
            bashShell: "bash",
        };
    },

    computed: {
        minecraftServiceName() {
            const services = this.jsonConfig?.services || {};
            for (const [ name, svc ] of Object.entries(services)) {
                const image = (svc?.image || "").toLowerCase();
                if (MINECRAFT_IMAGES.some(img => image.startsWith(img))) {
                    return name;
                }
            }
            return Object.keys(services)[0] || "";
        },

        bashTerminalName() {
            return getContainerExecTerminalName(this.endpoint, this.stackName, this.minecraftServiceName, 0);
        },
    },

    methods: {
        activateBash() {
            this.activeTab = "bash";
            this.bashEverActivated = true;
        },
        toggleBashShell() {
            this.bashShell = this.bashShell === "bash" ? "sh" : "bash";
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}

.mc-tabs {
    .nav-link {
        color: $dark-font-color3;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        border-radius: 0;
        padding: 8px 16px;

        &:hover {
            color: $dark-font-color;
            border-bottom-color: $dark-border-color;
        }

        &.active {
            color: $primary;
            border-bottom-color: $primary;
            background: transparent;
        }
    }
}

.mc-panel-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    > * {
        flex: 1;
        min-height: 0;
    }
}

.mc-bash-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.mc-bash-toolbar {
    flex: 0 0 auto;
}

.mc-bash-terminal {
    flex: 1;
    min-height: 0;
}

@media (max-width: $bp-mobile) {
    // On mobile the stacked terminal + charts naturally overflow the
    // viewport; let the page scroll the whole panel rather than clipping
    // it. Each tab body still scrolls internally for desktop.
    .mc-panel-content {
        overflow: visible;

        > * {
            flex: 0 0 auto;
            min-height: 0;
        }
    }
}
</style>
