<template>
    <div
        class="mc-files"
        @click="closeContextMenu"
        @contextmenu.prevent="onBgContextMenu($event)"
        @dragenter.prevent="onDragEnter"
        @dragleave.prevent="onDragLeave"
        @dragover.prevent
        @drop.prevent="handleDrop"
    >
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
                    >
                        <a v-if="i < breadcrumbParts.length - 1" href="#" @click.prevent="navigate(breadcrumbPaths[i])">{{ part }}</a>
                        <span v-else class="breadcrumb-current">{{ part }}</span>
                    </li>
                </ol>
            </nav>

            <button class="btn btn-sm btn-normal" :disabled="loading" title="Refresh" @click="reload">
                <font-awesome-icon icon="rotate" />
            </button>
            <label class="btn btn-sm btn-primary mb-0">
                <font-awesome-icon icon="upload" class="me-1" />
                Upload
                <input ref="fileInput" type="file" multiple class="d-none" @change="handleFileInput" />
            </label>
        </div>

        <!-- Drop zone overlay -->
        <div
            class="mc-files-drop-zone"
            :class="{ 'dragging': isDragging }"
        >
            <!-- File list -->
            <div v-if="loading" class="text-center py-4 text-secondary">
                <font-awesome-icon icon="spinner" spin /> Loading...
            </div>
            <div v-else-if="entries.length === 0 && !pendingNew" class="text-center py-4 text-secondary">
                Empty directory
                <div v-if="isDragging" class="mt-2 text-primary">Drop files here to upload</div>
            </div>
            <table v-else class="mc-files-table w-100">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th class="text-end">Size</th>
                        <th class="text-end">Modified</th>
                    </tr>
                </thead>
                <tbody>
                    <!-- Pending new file/folder (inline create) -->
                    <tr v-if="pendingNew" class="mc-file-row pending-new">
                        <td>
                            <font-awesome-icon
                                :icon="pendingNew.isDir ? 'folder' : 'file'"
                                class="me-2"
                                :class="pendingNew.isDir ? 'text-warning' : 'text-secondary'"
                            />
                            <input
                                ref="pendingNewInput"
                                v-model="pendingNew.name"
                                type="text"
                                class="mc-inline-input"
                                :placeholder="pendingNew.isDir ? 'New folder' : 'New file'"
                                @keyup.enter="commitPendingNew"
                                @keyup.escape="cancelPendingNew"
                                @blur="commitPendingNew"
                                @click.stop
                            />
                        </td>
                        <td class="text-end text-secondary">—</td>
                        <td class="text-end text-secondary">—</td>
                    </tr>

                    <tr
                        v-for="(entry, idx) in entries"
                        :key="entry.name"
                        class="mc-file-row"
                        :class="{ selected: isSelected(entry) }"
                        @click.stop="handleRowClick(entry, idx, $event)"
                        @dblclick.stop="handleRowDblClick(entry)"
                        @contextmenu.prevent.stop="onRowContextMenu($event, entry, idx)"
                    >
                        <td class="mc-file-name">
                            <template v-if="renamingEntry && renamingEntry.name === entry.name">
                                <font-awesome-icon
                                    :icon="entry.isDir ? 'folder' : 'file'"
                                    class="me-2"
                                    :class="entry.isDir ? 'text-warning' : 'text-secondary'"
                                />
                                <input
                                    ref="renameInput"
                                    v-model="renameValue"
                                    type="text"
                                    class="mc-inline-input"
                                    @keyup.enter="commitRename"
                                    @keyup.escape="cancelRename"
                                    @blur="commitRename"
                                    @click.stop
                                />
                            </template>
                            <template v-else>
                                <font-awesome-icon
                                    :icon="entry.isDir ? 'folder' : 'file'"
                                    class="me-2"
                                    :class="entry.isDir ? 'text-warning' : 'text-secondary'"
                                />
                                <span>{{ entry.name }}</span>
                            </template>
                        </td>
                        <td class="text-end text-secondary" style="white-space: nowrap">
                            {{ entry.isDir ? '—' : formatSize(entry.size) }}
                        </td>
                        <td class="text-end text-secondary" style="white-space: nowrap">
                            {{ formatDate(entry.mtime) }}
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

        <!-- Context menu -->
        <ul
            v-if="contextMenu.show"
            class="mc-context-menu"
            :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
            @click.stop
            @contextmenu.prevent.stop
        >
            <li v-if="ctxAction('open')" @click="runCtx('open')">
                <font-awesome-icon icon="folder-open" class="me-2" />Open
            </li>
            <li v-if="ctxAction('edit')" @click="runCtx('edit')">
                <font-awesome-icon icon="pen" class="me-2" />Edit
            </li>
            <li v-if="ctxAction('download')" @click="runCtx('download')">
                <font-awesome-icon icon="download" class="me-2" />
                Download{{ selectedEntries.length > 1 ? ` (${selectedEntries.length})` : '' }}
            </li>
            <li v-if="ctxAction('unzip')" @click="runCtx('unzip')">
                <font-awesome-icon icon="file-zipper" class="me-2" />Unzip
            </li>
            <li v-if="ctxAction('rename')" @click="runCtx('rename')">
                <font-awesome-icon icon="i-cursor" class="me-2" />Rename
            </li>
            <li v-if="ctxAction('delete')" class="danger" @click="runCtx('delete')">
                <font-awesome-icon icon="trash" class="me-2" />
                Delete{{ selectedEntries.length > 1 ? ` (${selectedEntries.length})` : '' }}
            </li>
            <li v-if="hasItemActions" class="separator"></li>
            <li @click="runCtx('newFile')">
                <font-awesome-icon icon="file" class="me-2" />New File
            </li>
            <li @click="runCtx('newFolder')">
                <font-awesome-icon icon="folder-plus" class="me-2" />New Folder
            </li>
        </ul>

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
    components: { FontAwesomeIcon,
        FileEditor },

    props: {
        endpoint: { type: String,
            required: true },
        stackName: { type: String,
            required: true },
        token: { type: String,
            default: "" },
    },

    data() {
        return {
            currentPath: "",
            entries: [],
            loading: false,
            uploading: false,
            isDragging: false,
            dragCounter: 0,
            editingFile: null,
            editingContent: "",
            selectedEntries: [],
            lastClickedIdx: null,
            contextMenu: { show: false,
                x: 0,
                y: 0,
                target: null }, // target=null → background menu
            pendingNew: null, // { name, isDir } during inline create
            renamingEntry: null, // entry currently being renamed
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
        hasItemActions() {
            return this.contextMenu.show && this.selectedEntries.length > 0;
        },
    },

    mounted() {
        this.reload();
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("scroll", this.closeContextMenu, true);
        window.addEventListener("popstate", this.onPopState);
        // Replace (not push) so the file browser's root state owns the
        // current history entry — no extra entry left behind on close.
        history.replaceState({ mcFilesPath: "" }, "");
    },

    beforeUnmount() {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("scroll", this.closeContextMenu, true);
        window.removeEventListener("popstate", this.onPopState);
    },

    methods: {
        joinPath(...parts) {
            return parts.filter(Boolean).join("/");
        },

        navigate(relPath, fromHistory = false) {
            this.currentPath = relPath;
            this.selectedEntries = [];
            this.lastClickedIdx = null;
            if (!fromHistory) {
                history.pushState({ mcFilesPath: relPath }, "");
            }
            this.reload();
        },

        onPopState(e) {
            const state = e.state;
            if (state && typeof state.mcFilesPath === "string") {
                // Navigate to the path the back button restored, without
                // pushing a new history entry on top of it.
                this.navigate(state.mcFilesPath, true);
            }
        },

        reload() {
            this.selectedEntries = [];
            this.lastClickedIdx = null;
            this.cancelPendingNew();
            this.cancelRename();
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

        isSelected(entry) {
            return this.selectedEntries.some(e => e.name === entry.name);
        },

        handleRowClick(entry, idx, event) {
            // Shift = range select.
            if (event.shiftKey && this.lastClickedIdx !== null) {
                const start = Math.min(this.lastClickedIdx, idx);
                const end = Math.max(this.lastClickedIdx, idx);
                this.selectedEntries = this.entries.slice(start, end + 1);
                return;
            }
            // Ctrl/Cmd = toggle individual.
            if (event.ctrlKey || event.metaKey) {
                if (this.isSelected(entry)) {
                    this.selectedEntries = this.selectedEntries.filter(e => e.name !== entry.name);
                } else {
                    this.selectedEntries = [ ...this.selectedEntries, entry ];
                }
                this.lastClickedIdx = idx;
                return;
            }
            // Plain click: single-select (folders behave the same as files now).
            if (this.isSelected(entry) && this.selectedEntries.length === 1) {
                this.selectedEntries = [];
            } else {
                this.selectedEntries = [ entry ];
            }
            this.lastClickedIdx = idx;
        },

        handleRowDblClick(entry) {
            if (entry.isDir) {
                this.navigate(this.joinPath(this.currentPath, entry.name));
            } else if (this.isEditable(entry.name)) {
                this.editFile(entry);
            } else {
                this.download(entry);
            }
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

        authToken() {
            const storage = this.$root.storage?.();
            return (storage && storage.token) || this.$root.socketIO?.token || "";
        },

        async downloadUrl(url, suggestedName) {
            try {
                const res = await fetch(url, {
                    headers: { "Authorization": `Bearer ${this.authToken()}` },
                });
                if (!res.ok) {
                    let msg = `Download failed (${res.status})`;
                    try {
                        const json = await res.json();
                        if (json && json.msg) {
                            msg = json.msg;
                        }
                    } catch (_) { /* not JSON */ }
                    this.$root.toastError(msg);
                    return;
                }
                const blob = await res.blob();
                const objectUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = objectUrl;
                a.download = suggestedName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            } catch (e) {
                this.$root.toastError("Download failed: " + e.message);
            }
        },

        download(entry) {
            const relPath = this.joinPath(this.currentPath, entry.name);
            const url = `/api/files/${encodeURIComponent(this.stackName)}/${relPath}`;
            const suggested = entry.isDir ? `${entry.name}.zip` : entry.name;
            this.downloadUrl(url, suggested);
        },

        downloadSelected() {
            if (this.selectedEntries.length === 0) {
                return;
            }
            if (this.selectedEntries.length === 1 && !this.selectedEntries[0].isDir) {
                this.download(this.selectedEntries[0]);
                return;
            }
            const params = new URLSearchParams();
            for (const entry of this.selectedEntries) {
                params.append("paths", this.joinPath(this.currentPath, entry.name));
            }
            const url = `/api/files-zip/${encodeURIComponent(this.stackName)}?${params.toString()}`;
            this.downloadUrl(url, `${this.stackName}.zip`);
        },

        async deleteSelected() {
            if (this.selectedEntries.length === 0) {
                return;
            }
            const names = this.selectedEntries.map(e => e.name).join(", ");
            if (!confirm(`Delete "${names}"?`)) {
                return;
            }
            for (const entry of this.selectedEntries) {
                const relPath = this.joinPath(this.currentPath, entry.name);
                await new Promise(resolve => {
                    this.$root.emitAgent(this.endpoint, "minecraftFileDelete", this.stackName, relPath, (res) => {
                        if (!res.ok) {
                            this.$root.toastError(res.msg || `Failed to delete ${entry.name}`);
                        }
                        resolve();
                    });
                });
            }
            this.reload();
        },

        // ----- Inline create (windows-style) -----
        startNew(isDir) {
            this.pendingNew = { name: "",
                isDir };
            this.$nextTick(() => {
                this.$refs.pendingNewInput?.focus();
            });
        },

        cancelPendingNew() {
            this.pendingNew = null;
        },

        commitPendingNew() {
            if (!this.pendingNew) {
                return;
            }
            const name = this.pendingNew.name.trim();
            const isDir = this.pendingNew.isDir;
            this.pendingNew = null;
            if (!name) {
                return;
            }
            if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
                this.$root.toastError("Invalid name");
                return;
            }
            const relPath = this.joinPath(this.currentPath, name);
            const evt = isDir ? "minecraftFileMkdir" : "minecraftFileTouch";
            this.$root.emitAgent(this.endpoint, evt, this.stackName, relPath, (res) => {
                if (res.ok) {
                    this.reload();
                } else {
                    this.$root.toastError(res.msg || `Failed to create ${isDir ? "folder" : "file"}`);
                }
            });
        },

        // ----- Inline rename -----
        startRename(entry) {
            this.renamingEntry = entry;
            this.renameValue = entry.name;
            this.$nextTick(() => {
                const el = Array.isArray(this.$refs.renameInput) ? this.$refs.renameInput[0] : this.$refs.renameInput;
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        cancelRename() {
            this.renamingEntry = null;
            this.renameValue = "";
        },

        commitRename() {
            if (!this.renamingEntry) {
                return;
            }
            const entry = this.renamingEntry;
            const newName = this.renameValue.trim();
            this.renamingEntry = null;
            if (!newName || newName === entry.name) {
                return;
            }
            const relPath = this.joinPath(this.currentPath, entry.name);
            this.$root.emitAgent(this.endpoint, "minecraftFileRename", this.stackName, relPath, newName, (res) => {
                if (res.ok) {
                    this.reload();
                } else {
                    this.$root.toastError(res.msg || "Rename failed");
                }
            });
        },

        // ----- Unzip -----
        unzipSelected() {
            const entry = this.selectedEntries[0];
            if (!entry || entry.isDir || !entry.name.toLowerCase().endsWith(".zip")) {
                return;
            }
            const relPath = this.joinPath(this.currentPath, entry.name);
            this.$root.emitAgent(this.endpoint, "minecraftFileUnzip", this.stackName, relPath, (res) => {
                if (res.ok) {
                    this.$root.toastSuccess(`Extracted ${res.count} entries`);
                    this.reload();
                } else {
                    this.$root.toastError(res.msg || "Unzip failed");
                }
            });
        },

        // ----- Context menu -----
        onRowContextMenu(event, entry) {
            if (!this.isSelected(entry)) {
                this.selectedEntries = [ entry ];
            }
            this.openContextMenu(event, entry);
        },

        onBgContextMenu(event) {
            // Right-click on empty space: clear selection, show menu with create-only items.
            if (event.target.closest(".mc-file-row")) {
                return;
            }
            this.selectedEntries = [];
            this.openContextMenu(event, null);
        },

        openContextMenu(event, target) {
            this.contextMenu = {
                show: true,
                x: event.clientX,
                y: event.clientY,
                target,
            };
        },

        closeContextMenu() {
            if (this.contextMenu.show) {
                this.contextMenu.show = false;
            }
        },

        ctxAction(name) {
            const sel = this.selectedEntries;
            const oneFile = sel.length === 1 && !sel[0].isDir;
            const oneDir = sel.length === 1 && sel[0].isDir;
            switch (name) {
                case "open": return oneDir;
                case "edit": return oneFile && this.isEditable(sel[0].name);
                case "download": return sel.length > 0;
                case "unzip": return oneFile && sel[0].name.toLowerCase().endsWith(".zip");
                case "rename": return sel.length === 1;
                case "delete": return sel.length > 0;
            }
            return false;
        },

        runCtx(action) {
            const sel = this.selectedEntries;
            this.closeContextMenu();
            switch (action) {
                case "open":
                    this.navigate(this.joinPath(this.currentPath, sel[0].name));
                    break;
                case "edit":
                    this.editFile(sel[0]);
                    break;
                case "download":
                    this.downloadSelected();
                    break;
                case "unzip":
                    this.unzipSelected();
                    break;
                case "rename":
                    this.startRename(sel[0]);
                    break;
                case "delete":
                    this.deleteSelected();
                    break;
                case "newFile":
                    this.startNew(false);
                    break;
                case "newFolder":
                    this.startNew(true);
                    break;
            }
        },

        onKeyDown(e) {
            if (e.key === "Escape") {
                this.closeContextMenu();
            }
        },

        // ----- Upload -----
        async uploadFiles(files) {
            if (!files.length) {
                return;
            }
            this.uploading = true;
            const uploadPath = this.currentPath ? `${this.currentPath}/` : "";
            const url = `/api/files/${encodeURIComponent(this.stackName)}/${uploadPath}`;
            const formData = new FormData();
            for (const file of files) {
                formData.append("files", file);
            }
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${this.authToken()}` },
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
            this.dragCounter = 0;
            this.isDragging = false;
            if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) {
                return;
            }
            const files = Array.from(e.dataTransfer.files);
            this.uploadFiles(files);
        },

        onDragEnter(e) {
            // Only react to OS file drags, not internal text/element drags.
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) {
                return;
            }
            this.dragCounter++;
            this.isDragging = true;
        },

        onDragLeave() {
            if (this.dragCounter > 0) {
                this.dragCounter--;
            }
            if (this.dragCounter === 0) {
                this.isDragging = false;
            }
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
    min-height: 0;
}

.mc-files-drop-zone {
    flex: 1;
    min-height: 0;
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
    font-size: 14px;
    user-select: none;

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

        &.selected {
            background: rgba(116, 194, 255, 0.1);
        }

        &.pending-new {
            background: rgba(116, 194, 255, 0.08);
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

.breadcrumb {
    background: transparent;
    font-size: 14px;
    a {
        color: $primary;
        text-decoration: none;
        &:hover {
            text-decoration: underline;
        }
    }
    .breadcrumb-current {
        color: $primary;
    }
    // Override Bootstrap's muted .active style.
    .breadcrumb-item.active {
        color: $primary;
    }
}

.mc-inline-input {
    background: $dark-bg;
    color: $dark-font-color;
    border: 1px solid $primary;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 14px;
    outline: none;
    width: calc(100% - 30px);
}

.mc-context-menu {
    position: fixed;
    z-index: 1080;
    min-width: 180px;
    background: $dark-header-bg;
    border: 1px solid $dark-border-color;
    border-radius: 6px;
    padding: 4px 0;
    margin: 0;
    list-style: none;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    font-size: 14px;

    li {
        padding: 6px 14px;
        cursor: pointer;
        color: $dark-font-color;
        display: flex;
        align-items: center;

        &:hover {
            background: rgba(116, 194, 255, 0.15);
        }

        &.danger {
            color: #f47272;
            &:hover {
                background: rgba(244, 114, 114, 0.15);
            }
        }

        &.separator {
            height: 1px;
            padding: 0;
            margin: 4px 0;
            background: $dark-border-color;
            cursor: default;
            &:hover {
                background: $dark-border-color;
            }
        }
    }
}
</style>
