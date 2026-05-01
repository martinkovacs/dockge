<template>
    <BModal
        v-model="show"
        size="xl"
        centered
        :title="dirPath || filePath"
        :ok-title="saving ? 'Saving...' : 'Save'"
        cancel-title="Cancel"
        :ok-disabled="saving"
        @ok.prevent="save"
        @hidden="$emit('close')"
    >
        <div class="mb-2">
            <label class="form-label filename-label">Filename</label>
            <input v-model="fileName" class="form-control form-control-sm font-mono" />
        </div>
        <div class="editor-box">
            <code-mirror
                v-model="localContent"
                :extensions="extensions"
                minimal
                wrap="true"
                dark="true"
                tab="true"
            />
        </div>
    </BModal>
</template>

<script>
import CodeMirror from "vue-codemirror6";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { dracula as editorTheme } from "thememirror";
import { lineNumbers } from "@codemirror/view";
import { BModal } from "bootstrap-vue-next";

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
        BModal },

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
            show: true,
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
                        this.show = false;
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
.filename-label {
    font-size: 12px;
    color: #888;
    margin-bottom: 4px;
}

.font-mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
}

.editor-box {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    min-height: 400px;
    max-height: 60vh;
    overflow-y: auto;
}
</style>
