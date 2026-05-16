<template>
    <div class="file-editor-inline">
        <div class="file-editor-header">
            <button
                class="btn btn-sm btn-normal"
                title="Back"
                @click="$emit('close')"
            >
                <font-awesome-icon icon="chevron-left" />
            </button>
            <div class="file-editor-path">
                <span v-if="dirPath" class="text-secondary">{{ dirPath }}/</span>
                <input v-model="fileName" class="form-control form-control-sm font-mono filename-input" />
            </div>
            <button
                class="btn btn-sm btn-primary"
                :disabled="saving"
                @click="save"
            >
                <font-awesome-icon v-if="saving" icon="spinner" spin class="me-1" />
                <font-awesome-icon v-else icon="save" class="me-1" />
                {{ saving ? 'Saving...' : 'Save' }}
            </button>
        </div>
        <div class="editor-box">
            <code-mirror
                v-model="localContent"
                :extensions="extensions"
                minimal
                wrap="true"
                dark="true"
                tab="true"
                @ready="onEditorReady"
            />
        </div>
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import CodeMirror from "vue-codemirror6";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { dracula as editorTheme } from "thememirror";
import { lineNumbers } from "@codemirror/view";

function extensionsForFile(filename) {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const base = [ editorTheme, lineNumbers() ];
    if (ext === "yml" || ext === "yaml") {
        return [ ...base, yaml() ];
    } else if (ext === "json") {
        return [ ...base, json() ];
    } else if (ext === "js" || ext === "ts" || ext === "mjs") {
        return [ ...base, javascript() ];
    } else if (ext === "py") {
        return [ ...base, python() ];
    }
    return base;
}

export default {
    components: { CodeMirror,
        FontAwesomeIcon },

    props: {
        filePath: {
            type: String,
            required: true,
        },
        content: {
            type: String,
            required: true,
        },
        endpoint: {
            type: String,
            required: true,
        },
        stackName: {
            type: String,
            required: true,
        },
    },

    emits: [ "close", "saved" ],

    data() {
        return {
            localContent: this.content,
            saving: false,
            fileName: this.filePath.split("/").pop(),
        };
    },

    computed: {
        extensions() {
            return extensionsForFile(this.filePath);
        },
        dirPath() {
            const parts = this.filePath.split("/");
            parts.pop();
            return parts.join("/") || "";
        },
    },

    methods: {
        onEditorReady({ view }) {
            // CodeMirror measures the gutter at mount time, before the
            // flex parent has been laid out and before web fonts have
            // loaded — the line numbers end up with the default
            // line-height and only snap into place once the editor
            // receives focus. Force a remeasure after layout + fonts
            // settle so the gutter is correct on first paint.
            const remeasure = () => view.requestMeasure();
            requestAnimationFrame(remeasure);
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(remeasure).catch(() => {});
            }
        },

        save() {
            this.saving = true;
            const originalName = this.filePath.split("/").pop();
            const nameChanged = this.fileName !== originalName;
            const newPath = this.dirPath ? `${this.dirPath}/${this.fileName}` : this.fileName;

            const doSave = (savePath) => {
                this.$root.emitAgent(this.endpoint, "minecraftFileSave", this.stackName, savePath, this.localContent, (res) => {
                    this.saving = false;
                    if (res.ok) {
                        this.$root.toastSuccess("File saved");
                        this.$emit("saved");
                    } else {
                        this.$root.toastError(res.msg || "Failed to save");
                    }
                });
            };

            if (nameChanged) {
                this.$root.emitAgent(this.endpoint, "minecraftFileRename", this.stackName, this.filePath, this.fileName, (res) => {
                    if (res.ok) {
                        doSave(newPath);
                    } else {
                        this.saving = false;
                        this.$root.toastError(res.msg || "Failed to rename");
                    }
                });
            } else {
                doSave(this.filePath);
            }
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.file-editor-inline {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}

.file-editor-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.file-editor-path {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
}

.filename-input {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    max-width: 320px;
}

.font-mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
}

.editor-box {
    flex: 1;
    min-height: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    overflow: auto;
    border: 1px solid $dark-border-color;
    border-radius: 6px;

    // Pin the line-height on both sides of the gutter so a font-loading
    // race can never desync the line numbers from the content rows.
    :deep(.cm-content),
    :deep(.cm-gutterElement) {
        line-height: 1.5;
    }
}
</style>
