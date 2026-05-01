<template>
    <div class="container-fluid">
        <div class="d-flex">
            <div v-if="!$root.isMobile" class="stacks-sidebar me-3">
                <div>
                    <router-link to="/compose" class="btn btn-primary mb-3"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
                </div>
                <StackList :scrollbar="true" />
            </div>

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
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
};
</script>

<style lang="scss" scoped>
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
</style>
