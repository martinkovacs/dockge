<template>
    <div class="mini-chart-wrapper">
        <div class="mini-chart-label">{{ label }}</div>
        <div class="mini-chart-value">{{ currentValue }}</div>
        <div class="mini-chart-canvas-wrap">
            <canvas ref="canvas"></canvas>
        </div>
    </div>
</template>

<script>
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler } from "chart.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler);

export default {
    props: {
        label: {
            type: String,
            required: true,
        },
        datasets: {
            type: Array,
            default: () => [],
            // [{ label, data: number[], color }]
        },
        unit: {
            type: String,
            default: "%",
        },
        maxY: {
            type: Number,
            default: null,
        },
    },

    data() {
        return {
            chart: null,
        };
    },

    computed: {
        currentValue() {
            if (!this.datasets.length) {
                return "—";
            }
            const vals = this.datasets.map(ds => {
                const data = ds.data;
                return data.length > 0 ? data[data.length - 1] : null;
            }).filter(v => v !== null);
            if (vals.length === 0) {
                return "—";
            }
            if (this.datasets.length === 1) {
                return vals[0].toFixed(1) + " " + this.unit;
            }
            return this.datasets.map((ds, i) => {
                const v = vals[i] ?? 0;
                return `${ds.label}: ${v.toFixed(1)} ${this.unit}`;
            }).join("  ");
        },
    },

    watch: {
        datasets: {
            deep: true,
            handler() {
                this.updateChart();
            },
        },
    },

    mounted() {
        this.createChart();
        this.$nextTick(() => {
            this.chart?.resize();
        });
    },

    beforeUnmount() {
        if (this.chart) {
            this.chart.destroy();
        }
    },

    methods: {
        buildChartDatasets() {
            return this.datasets.map(ds => ({
                label: ds.label,
                data: [ ...ds.data ],
                borderColor: ds.color,
                backgroundColor: ds.color + "33",
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2,
            }));
        },

        createChart() {
            const ctx = this.$refs.canvas.getContext("2d");
            const length = this.datasets[0]?.data.length || 60;
            const labels = Array(length).fill("");

            this.chart = new Chart(ctx, {
                type: "line",
                data: {
                    labels,
                    datasets: this.buildChartDatasets(),
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    layout: {
                        padding: { bottom: 4 },
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: { enabled: false },
                    },
                    scales: {
                        x: { display: false },
                        y: {
                            display: false,
                            min: -0.5,
                            max: this.maxY ?? undefined,
                            suggestedMax: this.maxY ?? 10,
                        },
                    },
                },
            });
        },

        updateChart() {
            if (!this.chart) {
                return;
            }
            const newDatasets = this.buildChartDatasets();
            const length = newDatasets[0]?.data.length || 60;
            this.chart.data.labels = Array(length).fill("");
            this.chart.data.datasets.forEach((ds, i) => {
                if (newDatasets[i]) {
                    ds.data = newDatasets[i].data;
                    ds.borderColor = newDatasets[i].borderColor;
                    ds.backgroundColor = newDatasets[i].backgroundColor;
                }
            });
            // Add or remove datasets if count changed
            while (this.chart.data.datasets.length < newDatasets.length) {
                this.chart.data.datasets.push(newDatasets[this.chart.data.datasets.length]);
            }
            while (this.chart.data.datasets.length > newDatasets.length) {
                this.chart.data.datasets.pop();
            }
            this.chart.update("none");
        },
    },
};
</script>

<style scoped lang="scss">
@import "../../styles/vars.scss";

.mini-chart-wrapper {
    background: $dark-header-bg;
    border-radius: 8px;
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.mini-chart-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: $dark-font-color3;
}

.mini-chart-value {
    font-size: 14px;
    font-weight: 600;
    color: $dark-font-color;
    min-height: 20px;
}

.mini-chart-canvas-wrap {
    height: 60px;
    position: relative;
}
</style>
