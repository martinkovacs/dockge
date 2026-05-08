<template>
    <div class="container-fluid">
        <div class="d-flex">
            <div
                class="stacks-sidebar me-3"
                :class="{ 'mobile-open': $root.sidebarOpen }"
            >
                <div>
                    <router-link to="/compose" class="btn btn-primary mb-3"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
                </div>
                <StackList :scrollbar="true" />
            </div>

            <div
                v-if="$root.isMobile && $root.sidebarOpen"
                class="sidebar-backdrop"
                @click="$root.sidebarOpen = false"
            ></div>

            <div ref="container" class="content-area mb-3">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>

import StackList from "../components/StackList.vue";

export default {
    components: {
        StackList,
    },
    data() {
        return {
            height: 0
        };
    },
    watch: {
        "$route.fullPath"() {
            // close drawer on navigation
            if (this.$root.isMobile) {
                this.$root.sidebarOpen = false;
            }
        },
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.container-fluid {
    width: 98%;
}

.stacks-sidebar {
    flex: 0 0 20%;
    max-width: 420px;
    width: 20%;
    min-width: 0;
}

.content-area {
    flex: 1;
    min-width: 0;
}

@media (max-width: $bp-mobile) {
    .container-fluid {
        width: 100%;
        padding-left: 0.75rem;
        padding-right: 0.75rem;
    }

    .stacks-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 80vw;
        max-width: 320px;
        z-index: 1040;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        background-color: $dark-bg;
        padding: 1rem;
        overflow-y: auto;
        box-shadow: 2px 0 12px rgba(0, 0, 0, 0.4);
        margin-right: 0 !important;

        &.mobile-open {
            transform: translateX(0);
        }
    }

    .content-area {
        flex: 1 1 100%;
        width: 100%;
        min-width: 0;
    }
}

.sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1039;
}
</style>
