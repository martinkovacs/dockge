<template>
    <div class="my-4">
        <h5 class="mb-3">Minecraft View</h5>
        <p class="text-secondary mb-3" style="font-size: 13px;">
            Override the Minecraft panel visibility per stack.
            <strong>Auto</strong> shows it when <code>itzg/minecraft-server</code> or <code>itzg/mc-proxy</code> is detected.
        </p>

        <div v-if="loading" class="text-secondary">
            <font-awesome-icon icon="spinner" spin /> Loading stacks...
        </div>
        <div v-else-if="stacks.length === 0" class="text-secondary">
            No stacks found.
        </div>
        <table v-else class="table table-sm stacks-table">
            <thead>
                <tr>
                    <th>Stack</th>
                    <th>Minecraft View</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="stack in stacks" :key="stack.name">
                    <td class="align-middle">
                        <font-awesome-icon icon="layer-group" class="me-2 text-secondary" />
                        {{ stack.name }}
                    </td>
                    <td>
                        <div class="btn-group btn-group-sm" role="group">
                            <button
                                v-for="opt in modeOptions"
                                :key="opt.value"
                                type="button"
                                class="btn"
                                :class="getMode(stack.name) === opt.value ? 'btn-primary' : 'btn-outline-secondary'"
                                @click="setMode(stack.name, opt.value)"
                            >
                                {{ opt.label }}
                            </button>
                        </div>
                    </td>
                </tr>
            </tbody>
        </table>

        <div v-if="savedMsg" class="alert alert-success mt-2 py-1 px-3" style="font-size: 13px;">
            {{ savedMsg }}
        </div>
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

export default {
    components: { FontAwesomeIcon },

    data() {
        return {
            loading: true,
            stacks: [],
            modes: {},
            savedMsg: "",
            saveMsgTimeout: null,
            modeOptions: [
                { value: "auto",
                    label: "Auto" },
                { value: "on",
                    label: "Always On" },
                { value: "off",
                    label: "Always Off" },
            ],
        };
    },

    mounted() {
        this.loadStacks();
        this.loadModes();
    },

    methods: {
        loadStacks() {
            this.loading = true;
            // completeStackList is already populated in the root state
            const list = this.$root.completeStackList || {};
            this.stacks = Object.values(list);
            this.loading = false;
        },

        loadModes() {
            this.$root.emitAgent("", "getStackMinecraftSettings", (res) => {
                if (res.ok && res.settings) {
                    const modes = {};
                    for (const [ key, val ] of Object.entries(res.settings)) {
                        const stackName = key.replace("minecraftView_", "");
                        modes[stackName] = val?.mode || "auto";
                    }
                    this.modes = modes;
                }
            });
        },

        getMode(stackName) {
            return this.modes[stackName] || "auto";
        },

        setMode(stackName, mode) {
            this.modes = { ...this.modes,
                [stackName]: mode };
            this.$root.emitAgent("", "setStackMinecraftView", stackName, mode, (res) => {
                if (res.ok) {
                    this.showSaved(`Saved for "${stackName}"`);
                } else {
                    this.$root.toastError(res.msg || "Failed to save");
                }
            });
        },

        showSaved(msg) {
            this.savedMsg = msg;
            clearTimeout(this.saveMsgTimeout);
            this.saveMsgTimeout = setTimeout(() => {
                this.savedMsg = "";
            }, 2000);
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.stacks-table {
    font-size: 13px;

    th {
        color: $dark-font-color3;
        font-weight: 500;
    }
}
</style>
