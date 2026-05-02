<template>
    <div class="mc-limits">
        <div class="mc-limits-header mb-3">
            <h5 class="mb-1">Resource Limits</h5>
            <p class="text-secondary mb-0" style="font-size: 13px;">
                Edits <code>compose.yaml</code> in place. A stack restart is required to apply changes.
            </p>
        </div>

        <div class="mc-limits-grid">
            <!-- JVM Memory -->
            <div class="mc-limit-card mc-limit-card-wide">
                <div class="mc-limit-card-title">
                    <font-awesome-icon icon="cube" class="me-2 text-primary" />
                    JVM Memory
                </div>
                <div class="mc-limit-row-grid">
                    <div class="mc-limit-row">
                        <label>
                            -Xms <span class="mc-limit-envname">(INIT_MEMORY)</span>
                        </label>
                        <input
                            v-model="form.initMemory"
                            type="text"
                            class="form-control form-control-sm"
                            placeholder="e.g. 1G"
                        />
                    </div>
                    <div class="mc-limit-row">
                        <label>
                            -Xmx <span class="mc-limit-envname">(MAX_MEMORY)</span>
                        </label>
                        <input
                            v-model="form.maxMemory"
                            type="text"
                            class="form-control form-control-sm"
                            placeholder="e.g. 4G"
                        />
                    </div>
                </div>
            </div>

            <!-- CPU -->
            <div class="mc-limit-card">
                <div class="mc-limit-card-title">
                    <font-awesome-icon icon="microchip" class="me-2 text-primary" />
                    CPU
                </div>
                <div class="mc-limit-row">
                    <label>Limit (cores)</label>
                    <input
                        v-model="form.cpuLimit"
                        type="text"
                        class="form-control form-control-sm"
                        placeholder="e.g. 2 or 1.5"
                    />
                </div>
                <div class="mc-limit-row">
                    <label>Reservation (cores)</label>
                    <input
                        v-model="form.cpuReservation"
                        type="text"
                        class="form-control form-control-sm"
                        placeholder="e.g. 0.5"
                    />
                </div>
            </div>

            <!-- Memory -->
            <div class="mc-limit-card">
                <div class="mc-limit-card-title">
                    <font-awesome-icon icon="memory" class="me-2 text-primary" />
                    Memory
                </div>
                <div class="mc-limit-row">
                    <label>Limit</label>
                    <input
                        v-model="form.memLimit"
                        type="text"
                        class="form-control form-control-sm"
                        placeholder="e.g. 2G or 512M"
                    />
                </div>
                <div class="mc-limit-row">
                    <label>Reservation</label>
                    <input
                        v-model="form.memReservation"
                        type="text"
                        class="form-control form-control-sm"
                        placeholder="e.g. 256M"
                    />
                </div>
            </div>
        </div>

        <div class="mt-4 d-flex align-items-center gap-2">
            <button class="btn btn-primary" :disabled="saving || !serviceName" @click="save">
                <font-awesome-icon v-if="saving" icon="spinner" spin class="me-1" />
                <font-awesome-icon v-else icon="save" class="me-1" />
                Save
            </button>
            <button class="btn btn-normal" :disabled="saving" @click="reset">
                Reset
            </button>
            <span v-if="dirty" class="text-warning ms-2" style="font-size: 13px;">
                Unsaved changes
            </span>
        </div>
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { readResourceLimits, readJvmMemory } from "./mcCompose";

function emptyForm() {
    return {
        cpuLimit: "",
        cpuReservation: "",
        memLimit: "",
        memReservation: "",
        initMemory: "",
        maxMemory: "",
    };
}

function readFromCompose(jsonConfig, serviceName) {
    return {
        ...emptyForm(),
        ...readResourceLimits(jsonConfig, serviceName),
        ...readJvmMemory(jsonConfig, serviceName),
    };
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
        jsonConfig: { type: Object,
            default: () => ({}) },
    },

    emits: [ "saved" ],

    data() {
        return {
            form: emptyForm(),
            initial: emptyForm(),
            saving: false,
        };
    },

    computed: {
        dirty() {
            return Object.keys(this.form).some(k => (this.form[k] || "") !== (this.initial[k] || ""));
        },
    },

    watch: {
        jsonConfig: {
            deep: true,
            immediate: true,
            handler() {
                this.reset();
            },
        },
        serviceName() {
            this.reset();
        },
    },

    methods: {
        reset() {
            this.form = readFromCompose(this.jsonConfig, this.serviceName);
            this.initial = { ...this.form };
        },

        save() {
            if (!this.serviceName) {
                return;
            }
            this.saving = true;
            const payload = {
                cpuLimit: this.form.cpuLimit.trim() || null,
                cpuReservation: this.form.cpuReservation.trim() || null,
                memLimit: this.form.memLimit.trim() || null,
                memReservation: this.form.memReservation.trim() || null,
                initMemory: this.form.initMemory.trim() || null,
                maxMemory: this.form.maxMemory.trim() || null,
            };
            this.$root.emitAgent(this.endpoint, "minecraftSetLimits", this.stackName, this.serviceName, payload, (res) => {
                this.saving = false;
                if (res.ok) {
                    this.$root.toastSuccess("Saved. Restart the stack to apply.");
                    this.initial = { ...this.form };
                    this.$emit("saved");
                } else {
                    this.$root.toastError(res.msg || "Failed to save limits");
                }
            });
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-limits {
    height: 100%;
    overflow: auto;
    padding-right: 6px;
}

.mc-limits-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
}

.mc-limit-card-wide {
    grid-column: 1 / -1;
}

.mc-limit-row-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px 14px;
}

.mc-limit-envname {
    font-size: 11px;
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;
    margin-left: 2px;
}

.mc-limit-card {
    background: $dark-header-bg;
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.mc-limit-card-title {
    font-size: 14px;
    font-weight: 600;
    color: $dark-font-color;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.mc-limit-row {
    display: flex;
    flex-direction: column;
    gap: 4px;

    label {
        font-size: 12px;
        color: $dark-font-color3;
    }
}

.mc-limit-note {
    font-size: 11px;
    line-height: 1.4;
}
</style>
