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

// Round `value` up to a "nice" number (1, 2, 2.5, 5, 10) × 10^n so the
// y-axis can be split into evenly-spaced ticks ending on a round number.
function niceCeil(value) {
    if (value <= 0) {
        return 10;
    }
    const exp = Math.floor(Math.log10(value));
    const base = Math.pow(10, exp);
    const m = value / base;
    let nice;
    if (m <= 1) {
        nice = 1;
    } else if (m <= 2) {
        nice = 2;
    } else if (m <= 2.5) {
        nice = 2.5;
    } else if (m <= 5) {
        nice = 5;
    } else {
        nice = 10;
    }
    return nice * base;
}

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
        // When true and the peak data value exceeds maxY, the y-axis grows
        // to fit the peak instead of clipping it. When false (default), maxY
        // is a hard ceiling.
        allowGrowAboveMax: {
            type: Boolean,
            default: false,
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
            const peak = Math.max(
                0,
                ...this.datasets.flatMap(ds => ds.data || []),
            );
            // Resolve the y-axis ceiling:
            //  * no maxY → grow to ~115% of peak (min 10) so the line never
            //    touches the top edge.
            //  * maxY set, peak <= maxY → cap at maxY.
            //  * maxY set, peak > maxY → only honour the cap when
            //    allowGrowAboveMax is false; otherwise grow to ~110% of peak.
            let rawMax;
            if (this.maxY == null) {
                rawMax = Math.max(10, peak * 1.15);
            } else if (peak > this.maxY && this.allowGrowAboveMax) {
                rawMax = peak * 1.1;
            } else {
                rawMax = this.maxY;
            }
            // Hard-capped axes (e.g. memory at 100%) keep their nominal max so
            // the gridlines line up at 0/50/100. Otherwise round up to a nice
            // number so the two ticks at yMax/2 and yMax always land on round
            // values and are equally spaced.
            const yMax = (this.maxY != null && rawMax === this.maxY)
                ? this.maxY
                : niceCeil(rawMax);
            const stepSize = yMax / 2;
            const unit = this.unit;

            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                layout: {
                    padding: { top: 4,
                        bottom: 2,
                        left: 2 },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                },
                scales: {
                    x: { display: false },
                    y: {
                        display: true,
                        min: 0,
                        max: yMax,
                        border: { display: false },
                        grid: {
                            color: "rgba(255,255,255,0.05)",
                            drawTicks: false,
                        },
                        ticks: {
                            stepSize,
                            font: { size: 9 },
                            color: "#888",
                            padding: 2,
                            callback(value) {
                                const n = Number(value);
                                const formatted = Number.isInteger(n) ? n : n.toFixed(1);
                                return `${formatted}${unit}`;
                            },
                        },
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
    flex: 1 1 60px;
    min-height: 60px;
    position: relative;
}
</style>
