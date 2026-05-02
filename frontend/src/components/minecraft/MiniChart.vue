<template>
    <div class="mini-chart-wrapper">
        <div class="mini-chart-label">{{ label }}</div>
        <div class="mini-chart-value">
            <span>{{ currentValue }}</span>
            <span v-if="subValue" class="mini-chart-sub">{{ subValue }}</span>
        </div>
        <div class="mini-chart-canvas-wrap">
            <LineChart
                v-if="hasData"
                :data="chartData"
                :options="chartOptions"
            />
        </div>
    </div>
</template>

<script>
import { Line as LineChart } from "vue-chartjs";
import {
    Chart as ChartJS,
    LineController,
    LineElement,
    PointElement,
    LinearScale,
    CategoryScale,
    Filler,
} from "chart.js";

ChartJS.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler);

export default {
    components: { LineChart },

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
        subValue: {
            type: String,
            default: "",
        },
    },

    computed: {
        hasData() {
            return this.datasets.some(ds => ds.data && ds.data.length > 0);
        },

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

        chartLength() {
            return this.datasets[0]?.data.length || 60;
        },

        chartData() {
            const labels = Array(this.chartLength).fill("");
            return {
                labels,
                datasets: this.datasets.map(ds => ({
                    label: ds.label,
                    data: [ ...ds.data ],
                    borderColor: ds.color,
                    backgroundColor: ds.color + "33",
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    borderWidth: 2,
                })),
            };
        },

        chartOptions() {
            // Pick a suggestedMax slightly above the highest value so the line
            // never touches the top edge (was the source of the "cropped top").
            const peak = Math.max(
                0,
                ...this.datasets.flatMap(ds => ds.data || []),
            );
            const suggestedMax = this.maxY ?? Math.max(10, peak * 1.15);

            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                layout: {
                    padding: { top: 4,
                        bottom: 2 },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                },
                scales: {
                    x: { display: false },
                    y: {
                        display: false,
                        min: 0,
                        max: this.maxY ?? undefined,
                        suggestedMax,
                    },
                },
            };
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
    display: flex;
    align-items: baseline;
    gap: 6px;
}

.mini-chart-sub {
    font-size: 12px;
    font-weight: 400;
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;
}

.mini-chart-canvas-wrap {
    height: 60px;
    position: relative;
}
</style>
