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
        </div>
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import MinecraftConsole from "./MinecraftConsole.vue";
import MinecraftFiles from "./MinecraftFiles.vue";

const MINECRAFT_IMAGES = [ "itzg/minecraft-server", "itzg/mc-proxy" ];

export default {
    components: { FontAwesomeIcon,
        MinecraftConsole,
        MinecraftFiles },

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

    data() {
        return {
            activeTab: "console",
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
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
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
    overflow: hidden;
}
</style>
