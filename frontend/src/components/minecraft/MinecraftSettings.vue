<template>
    <div class="mc-settings">
        <div class="mc-settings-header mb-3">
            <h5 class="mb-1">Settings</h5>
            <p class="text-secondary mb-0" style="font-size: 13px;">
                Edits <code>compose.yaml</code> in place. A stack restart is required to apply changes.
            </p>
        </div>

        <!-- Environment variables -->
        <div class="mc-limit-card mb-3">
            <div class="mc-limit-card-title">
                <font-awesome-icon icon="list" class="me-2 text-primary" />
                Environment Variables
            </div>

            <datalist id="mc-env-var-names">
                <option
                    v-for="v in itzgVars"
                    :key="v.name"
                    :value="v.name"
                >
                    {{ v.description }}
                </option>
            </datalist>

            <div class="mc-env-rows">
                <div
                    v-for="(row, idx) in rows"
                    :key="row.id"
                    class="mc-env-row"
                >
                    <div class="mc-env-key">
                        <input
                            v-model="row.key"
                            type="text"
                            class="form-control form-control-sm"
                            placeholder="KEY"
                            list="mc-env-var-names"
                            spellcheck="false"
                            autocapitalize="off"
                            autocomplete="off"
                            @input="onKeyInput(idx)"
                        />
                        <span
                            v-if="describe(row.key)"
                            class="mc-env-help"
                            :title="describe(row.key)"
                        >
                            <font-awesome-icon icon="question-circle" />
                        </span>
                    </div>
                    <div class="mc-env-eq">=</div>
                    <input
                        v-model="row.value"
                        type="text"
                        class="form-control form-control-sm mc-env-value"
                        :placeholder="defaultFor(row.key) || 'value'"
                        spellcheck="false"
                        autocapitalize="off"
                    />
                    <button
                        class="btn btn-sm btn-normal mc-env-remove"
                        title="Remove"
                        @click="removeRow(idx)"
                    >
                        <font-awesome-icon icon="trash" />
                    </button>
                </div>

                <div v-if="!rows.length" class="mc-env-empty">
                    No environment variables defined.
                </div>

                <button class="btn btn-sm btn-normal mc-env-add" @click="addRow">
                    <font-awesome-icon icon="plus" class="me-1" />
                    Add variable
                </button>
            </div>
        </div>

        <!-- Garbage collector preset -->
        <div class="mc-limit-card mb-3">
            <div class="mc-limit-card-title">
                <font-awesome-icon icon="recycle" class="me-2 text-primary" />
                Garbage Collector Preset (Java 25)
            </div>
            <p class="text-secondary mb-2" style="font-size: 12px;">
                Writes <code>JVM_OPTS</code> when a preset is selected. Choose <em>Custom</em> to keep the current value.
            </p>
            <div class="mc-gc-row">
                <select v-model="gcPreset" class="form-select form-select-sm mc-gc-select">
                    <option value="custom">Custom (no preset)</option>
                    <option value="g1">G1 GC</option>
                    <option value="zgc">ZGC (Generational)</option>
                    <option value="shenandoah">Shenandoah (Generational)</option>
                </select>
            </div>
            <div v-if="gcPreset === 'custom' && currentJvmOpts" class="mc-gc-current mt-2">
                <div class="mc-gc-current-label">Current JVM_OPTS</div>
                <code class="mc-gc-current-value">{{ currentJvmOpts }}</code>
            </div>
            <div v-else-if="gcPreset !== 'custom'" class="mc-gc-current mt-2">
                <div class="mc-gc-current-label">Will write JVM_OPTS</div>
                <code class="mc-gc-current-value">{{ presetValue(gcPreset) }}</code>
            </div>
        </div>

        <div class="d-flex align-items-center gap-2">
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
import { readEnvMap } from "./mcCompose";
import itzgEnvVars from "./itzg-env-vars.json";

export const GC_PRESETS = {
    g1: "--add-modules=jdk.incubator.vector -XX:+UseG1GC -XX:MaxGCPauseMillis=75 -XX:G1NewSizePercent=35 -XX:G1MaxNewSizePercent=60 -XX:G1ReservePercent=15 -XX:InitiatingHeapOccupancyPercent=35 -XX:G1MixedGCCountTarget=8 -XX:G1HeapWastePercent=5 -XX:SurvivorRatio=16 -XX:MaxTenuringThreshold=3 -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+PerfDisableSharedMem -XX:+UseStringDeduplication -XX:+UseTransparentHugePages -XX:MaxMetaspaceSize=512M -XX:ReservedCodeCacheSize=320M",
    zgc: "--add-modules=jdk.incubator.vector -XX:+UseZGC -XX:+ZGenerational -XX:ZUncommitDelay=300 -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+PerfDisableSharedMem -XX:+UseStringDeduplication -XX:+UseTransparentHugePages -XX:MaxMetaspaceSize=512M -XX:ReservedCodeCacheSize=320M",
    shenandoah: "--add-modules=jdk.incubator.vector -XX:+UseShenandoahGC -XX:ShenandoahGCMode=generational -XX:ShenandoahUncommitDelay=60000 -XX:ShenandoahGuaranteedGCInterval=300000 -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+PerfDisableSharedMem -XX:+UseStringDeduplication -XX:+UseTransparentHugePages -XX:MaxMetaspaceSize=512M -XX:ReservedCodeCacheSize=320M",
};

let rowSeq = 0;
function newRow(key = "", value = "") {
    rowSeq += 1;
    return { id: rowSeq,
        key,
        value };
}

function rowsFromMap(map) {
    return Object.entries(map).map(([ k, v ]) => newRow(k, v));
}

function rowsToMap(rows) {
    const map = {};
    for (const row of rows) {
        const key = (row.key || "").trim();
        if (!key) {
            continue;
        }
        map[key] = row.value == null ? "" : String(row.value);
    }
    return map;
}

function detectPreset(jvmOpts) {
    for (const [ name, value ] of Object.entries(GC_PRESETS)) {
        if (jvmOpts === value) {
            return name;
        }
    }
    return "custom";
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
            rows: [],
            initialMap: {},
            initialJvmOpts: "",
            gcPreset: "custom",
            initialPreset: "custom",
            saving: false,
            itzgVars: itzgEnvVars.vars,
        };
    },

    computed: {
        currentJvmOpts() {
            const row = this.rows.find(r => (r.key || "").trim() === "JVM_OPTS");
            return row ? row.value : "";
        },

        currentMap() {
            return rowsToMap(this.rows);
        },

        dirty() {
            const cur = this.currentMap;
            const init = this.initialMap;
            const curKeys = Object.keys(cur);
            const initKeys = Object.keys(init);
            if (curKeys.length !== initKeys.length) {
                return true;
            }
            for (const k of curKeys) {
                if (cur[k] !== init[k]) {
                    return true;
                }
            }
            return this.gcPreset !== this.initialPreset;
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
        gcPreset(val) {
            // When the user picks a preset, write the corresponding JVM_OPTS.
            // Custom leaves it alone.
            if (val === "custom") {
                return;
            }
            const preset = GC_PRESETS[val];
            if (!preset) {
                return;
            }
            const row = this.rows.find(r => (r.key || "").trim() === "JVM_OPTS");
            if (row) {
                row.value = preset;
            } else {
                this.rows.push(newRow("JVM_OPTS", preset));
            }
        },
    },

    methods: {
        reset() {
            const map = readEnvMap(this.jsonConfig, this.serviceName);
            this.initialMap = { ...map };
            this.initialJvmOpts = map.JVM_OPTS || "";
            this.initialPreset = detectPreset(this.initialJvmOpts);
            this.gcPreset = this.initialPreset;
            this.rows = rowsFromMap(map);
        },

        addRow() {
            this.rows.push(newRow());
        },

        removeRow(idx) {
            this.rows.splice(idx, 1);
        },

        onKeyInput(idx) {
            // Trim whitespace introduced by datalist autocomplete.
            const row = this.rows[idx];
            if (row && typeof row.key === "string") {
                row.key = row.key.trim();
            }
        },

        describe(key) {
            const v = this.itzgVars.find(x => x.name === key);
            if (!v) {
                return "";
            }
            const def = v.default ? ` (default: ${v.default})` : "";
            return `${v.description}${def}`;
        },

        defaultFor(key) {
            const v = this.itzgVars.find(x => x.name === key);
            return v?.default || "";
        },

        presetValue(name) {
            return GC_PRESETS[name] || "";
        },

        save() {
            if (!this.serviceName) {
                return;
            }
            // Reject duplicate keys before sending.
            const seen = new Set();
            for (const row of this.rows) {
                const k = (row.key || "").trim();
                if (!k) {
                    continue;
                }
                if (seen.has(k)) {
                    this.$root.toastError(`Duplicate variable: ${k}`);
                    return;
                }
                seen.add(k);
            }
            this.saving = true;
            const payload = rowsToMap(this.rows);
            this.$root.emitAgent(this.endpoint, "minecraftSetEnv", this.stackName, this.serviceName, payload, (res) => {
                this.saving = false;
                if (res.ok) {
                    this.$root.toastSuccess("Saved. Restart the stack to apply.");
                    this.initialMap = { ...payload };
                    this.initialJvmOpts = payload.JVM_OPTS || "";
                    this.initialPreset = detectPreset(this.initialJvmOpts);
                    this.gcPreset = this.initialPreset;
                    this.$emit("saved");
                } else {
                    this.$root.toastError(res.msg || "Failed to save settings");
                }
            });
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-settings {
    height: 100%;
    overflow: auto;
    padding-right: 6px;
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

.mc-env-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.mc-env-row {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) auto minmax(160px, 2fr) auto;
    gap: 8px;
    align-items: center;
}

.mc-env-key {
    position: relative;
    display: flex;
    align-items: center;

    input {
        font-family: 'JetBrains Mono', monospace;
        padding-right: 28px;
    }
}

.mc-env-help {
    position: absolute;
    right: 8px;
    color: $dark-font-color3;
    font-size: 12px;
    cursor: help;

    &:hover {
        color: $primary;
    }
}

.mc-env-eq {
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;
    text-align: center;
}

.mc-env-value {
    font-family: 'JetBrains Mono', monospace;
}

.mc-env-remove {
    padding: 2px 8px;
}

.mc-env-empty {
    color: $dark-font-color3;
    font-size: 13px;
    padding: 4px 0;
}

.mc-env-add {
    align-self: flex-start;
    margin-top: 4px;
}

.mc-gc-row {
    display: flex;
    gap: 8px;
}

.mc-gc-select {
    max-width: 360px;
}

.mc-gc-current {
    background: $dark-bg;
    border: 1px solid $dark-border-color;
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.mc-gc-current-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: $dark-font-color3;
}

.mc-gc-current-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: $dark-font-color;
    word-break: break-all;
    white-space: pre-wrap;
}

@media (max-width: $bp-mobile) {
    .mc-env-row {
        grid-template-columns: 1fr;
        gap: 4px;
    }

    .mc-env-eq {
        display: none;
    }
}
</style>
