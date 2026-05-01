<template>
    <BModal
        v-model="show"
        size="xl"
        :title="filePath"
        :ok-title="saving ? 'Saving...' : 'Save'"
        cancel-title="Cancel"
        :ok-disabled="saving"
        @ok.prevent="save"
        @hidden="$emit('close')"
    >
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
    components: { CodeMirror, BModal },

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
        };
    },

    computed: {
        extensions() {
            return extensionsForFile(this.filePath);
        },
    },

    methods: {
        save() {
            this.saving = true;
            this.$root.emitAgent(this.endpoint, "minecraftFileSave", this.stackName, this.filePath, this.localContent, (res) => {
                this.saving = false;
                if (res.ok) {
                    this.$root.toastSuccess("File saved");
                    this.$emit("saved");
                    this.show = false;
                } else {
                    this.$root.toastError(res.msg || "Failed to save");
                }
            });
        },
    },
};
</script>

<style scoped lang="scss">
.editor-box {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    min-height: 400px;
    max-height: 60vh;
    overflow-y: auto;
}
</style>
