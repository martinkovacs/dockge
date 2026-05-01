<template>
    <div class="mc-files">
        <!-- Toolbar -->
        <div class="mc-files-toolbar d-flex align-items-center gap-2 mb-2">
            <!-- Breadcrumb -->
            <nav class="flex-grow-1">
                <ol class="breadcrumb mb-0">
                    <li class="breadcrumb-item">
                        <a href="#" @click.prevent="navigate('')">{{ stackName }}</a>
                    </li>
                    <li
                        v-for="(part, i) in breadcrumbParts"
                        :key="i"
                        class="breadcrumb-item"
                        :class="{ active: i === breadcrumbParts.length - 1 }"
                    >
                        <a v-if="i < breadcrumbParts.length - 1" href="#" @click.prevent="navigate(breadcrumbPaths[i])">{{ part }}</a>
                        <span v-else>{{ part }}</span>
                    </li>
                </ol>
            </nav>

            <!-- Actions -->
            <button class="btn btn-sm btn-normal" :disabled="loading" @click="reload">
                <font-awesome-icon icon="rotate" />
            </button>
            <button class="btn btn-sm btn-normal" @click="showMkdirPrompt = true">
                <font-awesome-icon icon="folder-plus" />
                New Folder
            </button>
            <label class="btn btn-sm btn-primary mb-0">
                <font-awesome-icon icon="upload" class="me-1" />
                Upload
                <input ref="fileInput" type="file" multiple class="d-none" @change="handleFileInput" />
            </label>
        </div>

        <!-- New folder prompt -->
        <div v-if="showMkdirPrompt" class="input-group mb-2">
            <input
                v-model="newFolderName"
                type="text"
                class="form-control form-control-sm"
                placeholder="Folder name"
                @keyup.enter="mkdir"
                @keyup.escape="showMkdirPrompt = false; newFolderName = ''"
            />
            <button class="btn btn-sm btn-primary" @click="mkdir">Create</button>
            <button class="btn btn-sm btn-normal" @click="showMkdirPrompt = false; newFolderName = ''">Cancel</button>
        </div>

        <!-- Drop zone overlay -->
        <div
            class="mc-files-drop-zone"
            :class="{ 'dragging': isDragging }"
            @dragover.prevent="isDragging = true"
            @dragleave="isDragging = false"
            @drop.prevent="handleDrop"
        >
            <!-- File list -->
            <div v-if="loading" class="text-center py-4 text-secondary">
                <font-awesome-icon icon="spinner" spin /> Loading...
            </div>
            <div v-else-if="entries.length === 0" class="text-center py-4 text-secondary">
                Empty directory
                <div v-if="isDragging" class="mt-2 text-primary">Drop files here to upload</div>
            </div>
            <table v-else class="mc-files-table w-100">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th class="text-end">Size</th>
                        <th class="text-end">Modified</th>
                        <th class="text-end">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <!-- Back row -->
                    <tr v-if="currentPath !== ''" class="mc-file-row" @click="navigateUp">
                        <td colspan="4">
                            <font-awesome-icon icon="folder" class="me-2 text-warning" />
                            ..
                        </td>
                    </tr>
                    <tr v-for="entry in entries" :key="entry.name" class="mc-file-row" @click.stop="entry.isDir ? navigate(joinPath(currentPath, entry.name)) : null">
                        <td class="mc-file-name">
                            <font-awesome-icon
                                :icon="entry.isDir ? 'folder' : 'file'"
                                class="me-2"
                                :class="entry.isDir ? 'text-warning' : 'text-secondary'"
                            />
                            <span v-if="renamingEntry === entry.name" class="d-inline-flex align-items-center gap-1" @click.stop>
                                <input
                                    v-model="renameValue"
                                    class="form-control form-control-sm d-inline-block"
                                    style="width: 200px"
                                    @keyup.enter="doRename(entry)"
                                    @keyup.escape="renamingEntry = null"
                                />
                                <button class="btn btn-sm btn-primary py-0" @click.stop="doRename(entry)">OK</button>
                                <button class="btn btn-sm btn-normal py-0" @click.stop="renamingEntry = null">✕</button>
                            </span>
                            <span v-else>{{ entry.name }}</span>
                        </td>
                        <td class="text-end text-secondary" style="white-space: nowrap">
                            {{ entry.isDir ? '—' : formatSize(entry.size) }}
                        </td>
                        <td class="text-end text-secondary" style="white-space: nowrap">
                            {{ formatDate(entry.mtime) }}
                        </td>
                        <td class="text-end" style="white-space: nowrap" @click.stop>
                            <button
                                v-if="!entry.isDir && isEditable(entry.name)"
                                class="btn btn-xs btn-normal me-1"
                                @click="editFile(entry)"
                            >Edit</button>
                            <button class="btn btn-xs btn-normal me-1" @click="download(entry)">
                                <font-awesome-icon icon="download" />
                            </button>
                            <button class="btn btn-xs btn-normal me-1" @click="startRename(entry)">
                                <font-awesome-icon icon="pen" />
                            </button>
                            <button class="btn btn-xs btn-danger" @click="deleteEntry(entry)">
                                <font-awesome-icon icon="trash" />
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
            <div v-if="isDragging" class="drop-hint">
                <font-awesome-icon icon="upload" size="2x" />
                <div>Drop files to upload</div>
            </div>
        </div>

        <!-- Uploading indicator -->
        <div v-if="uploading" class="mt-2 text-secondary">
            <font-awesome-icon icon="spinner" spin class="me-1" />
            Uploading...
        </div>

        <!-- File editor modal -->
        <FileEditor
            v-if="editingFile"
            :file-path="joinPath(currentPath, editingFile.name)"
            :content="editingContent"
            :endpoint="endpoint"
            :stack-name="stackName"
            @close="editingFile = null"
            @saved="reload"
        />
    </div>
</template>

<script>
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import FileEditor from "./FileEditor.vue";
import dayjs from "dayjs";

const EDITABLE_EXTS = new Set([
    "txt", "yml", "yaml", "json", "properties", "toml", "cfg", "conf", "ini",
    "sh", "env", "md", "log", "xml", "js", "ts", "py", "java",
]);

export default {
    components: { FontAwesomeIcon, FileEditor },

    props: {
        endpoint: { type: String, required: true },
        stackName: { type: String, required: true },
        token: { type: String, default: "" },
    },

    data() {
        return {
            currentPath: "",
            entries: [],
            loading: false,
            uploading: false,
            isDragging: false,
            editingFile: null,
            editingContent: "",
            showMkdirPrompt: false,
            newFolderName: "",
            renamingEntry: null,
            renameValue: "",
        };
    },

    computed: {
        breadcrumbParts() {
            if (!this.currentPath) {
                return [];
            }
            return this.currentPath.split("/").filter(Boolean);
        },
        breadcrumbPaths() {
            const parts = this.breadcrumbParts;
            return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
        },
    },

    mounted() {
        this.reload();
    },

    methods: {
        joinPath(...parts) {
            return parts.filter(Boolean).join("/");
        },

        navigate(relPath) {
            this.currentPath = relPath;
            this.reload();
        },

        navigateUp() {
            const parts = this.currentPath.split("/").filter(Boolean);
            parts.pop();
            this.currentPath = parts.join("/");
            this.reload();
        },

        reload() {
            this.loading = true;
            this.$root.emitAgent(this.endpoint, "minecraftFilelist", this.stackName, this.currentPath, (res) => {
                this.loading = false;
                if (res.ok) {
                    this.entries = res.entries;
                } else {
                    this.$root.toastError(res.msg || "Failed to list files");
                }
            });
        },

        isEditable(filename) {
            const ext = filename.split(".").pop()?.toLowerCase() || "";
            return EDITABLE_EXTS.has(ext);
        },

        editFile(entry) {
            const relPath = this.joinPath(this.currentPath, entry.name);
            this.$root.emitAgent(this.endpoint, "minecraftFileRead", this.stackName, relPath, (res) => {
                if (res.ok) {
                    this.editingFile = entry;
                    this.editingContent = res.content;
                } else {
                    this.$root.toastError(res.msg || "Failed to read file");
                }
            });
        },

        download(entry) {
            const relPath = this.joinPath(this.currentPath, entry.name);
            const token = this.$root.socket.token || "";
            const url = `/api/files/${encodeURIComponent(this.stackName)}/${relPath}?token=${encodeURIComponent(token)}`;
            window.open(url, "_blank");
        },

        startRename(entry) {
            this.renamingEntry = entry.name;
            this.renameValue = entry.name;
        },

        doRename(entry) {
            if (!this.renameValue || this.renameValue === entry.name) {
                this.renamingEntry = null;
                return;
            }
            const relPath = this.joinPath(this.currentPath, entry.name);
            this.$root.emitAgent(this.endpoint, "minecraftFileRename", this.stackName, relPath, this.renameValue, (res) => {
                this.renamingEntry = null;
                if (res.ok) {
                    this.reload();
                } else {
                    this.$root.toastError(res.msg || "Failed to rename");
                }
            });
        },

        deleteEntry(entry) {
            if (!confirm(`Delete "${entry.name}"?`)) {
                return;
            }
            const relPath = this.joinPath(this.currentPath, entry.name);
            this.$root.emitAgent(this.endpoint, "minecraftFileDelete", this.stackName, relPath, (res) => {
                if (res.ok) {
                    this.reload();
                } else {
                    this.$root.toastError(res.msg || "Failed to delete");
                }
            });
        },

        mkdir() {
            if (!this.newFolderName) {
                return;
            }
            const relPath = this.joinPath(this.currentPath, this.newFolderName);
            this.$root.emitAgent(this.endpoint, "minecraftFileMkdir", this.stackName, relPath, (res) => {
                this.showMkdirPrompt = false;
                this.newFolderName = "";
                if (res.ok) {
                    this.reload();
                } else {
                    this.$root.toastError(res.msg || "Failed to create folder");
                }
            });
        },

        async uploadFiles(files) {
            if (!files.length) {
                return;
            }
            this.uploading = true;
            const token = this.$root.socket.token || "";
            const uploadPath = this.currentPath ? `${this.currentPath}/` : "";
            const url = `/api/files/${encodeURIComponent(this.stackName)}/${uploadPath}`;
            const formData = new FormData();
            for (const file of files) {
                formData.append("files", file);
            }
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${token}` },
                    body: formData,
                });
                const json = await res.json();
                if (json.ok) {
                    this.$root.toastSuccess(`Uploaded ${files.length} file(s)`);
                    this.reload();
                } else {
                    this.$root.toastError(json.msg || "Upload failed");
                }
            } catch (e) {
                this.$root.toastError("Upload failed: " + e.message);
            } finally {
                this.uploading = false;
            }
        },

        handleFileInput(e) {
            const files = Array.from(e.target.files);
            this.$refs.fileInput.value = "";
            this.uploadFiles(files);
        },

        handleDrop(e) {
            this.isDragging = false;
            const files = Array.from(e.dataTransfer.files);
            this.uploadFiles(files);
        },

        formatSize(bytes) {
            if (bytes < 1024) {
                return bytes + " B";
            }
            if (bytes < 1024 * 1024) {
                return (bytes / 1024).toFixed(1) + " KB";
            }
            return (bytes / (1024 * 1024)).toFixed(1) + " MB";
        },

        formatDate(mtime) {
            return dayjs(mtime).format("MMM D, HH:mm");
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mc-files {
    display: flex;
    flex-direction: column;
    height: 100%;
}

.mc-files-drop-zone {
    flex: 1;
    border-radius: 8px;
    border: 2px dashed transparent;
    transition: border-color 0.2s, background 0.2s;
    position: relative;
    overflow: auto;

    &.dragging {
        border-color: $primary;
        background: rgba(116, 194, 255, 0.05);
    }
}

.drop-hint {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: $primary;
    background: rgba(0, 0, 0, 0.5);
    border-radius: 6px;
    pointer-events: none;
}

.mc-files-table {
    border-collapse: collapse;
    font-size: 13px;

    thead tr {
        border-bottom: 1px solid $dark-border-color;
        th {
            padding: 6px 8px;
            color: $dark-font-color3;
            font-weight: 500;
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: 0.04em;
        }
    }

    tbody tr.mc-file-row {
        cursor: pointer;
        border-bottom: 1px solid $dark-border-color;
        transition: background 0.1s;

        &:hover {
            background: $dark-header-bg;
        }

        td {
            padding: 7px 8px;
        }
    }
}

.mc-file-name {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.btn-xs {
    font-size: 11px;
    padding: 2px 7px;
}

.breadcrumb {
    background: transparent;
    font-size: 13px;
    a {
        color: $primary;
        text-decoration: none;
        &:hover {
            text-decoration: underline;
        }
    }
}
</style>
