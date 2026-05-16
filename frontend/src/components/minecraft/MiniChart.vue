<template>
    <div class="mini-chart-wrapper">
        <div class="mini-chart-label">{{ label }}</div>
        <div class="mini-chart-value" :class="{ 'mini-chart-value-split': perAxisValues.length > 1 }">
            <template v-if="perAxisValues.length > 1">
                <span
                    v-for="(v, i) in perAxisValues"
                    :key="v.label"
                    :class="['mini-chart-value-cell', i === perAxisValues.length - 1 ? 'mini-chart-value-cell-end' : '']"
                >
                    {{ v.label }}: <strong>{{ v.text }}</strong>
                </span>
            </template>
            <template v-else>
                <span>{{ currentValue }}</span>
                <span v-if="subValue" class="mini-chart-sub">{{ subValue }}</span>
            </template>
        </div>
        <div v-if="secondarySubValue && perAxisValues.length <= 1" class="mini-chart-sub-secondary">
            {{ secondarySubValue }}
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
    } else if (m <= 5) {
        nice = 5;
    } else {
        nice = 10;
    }
    return nice * base;
}

function ceilToStep(value, step) {
    return Math.ceil(value / step) * step;
}

// Y-axis ceiling for axes that can grow above their nominal max (currently
// CPU%, MSPT). Steps in 20 up to 500, 50 up to 1000, 100 beyond.
function growStepCeil(value) {
    if (value <= 500) {
        return ceilToStep(value, 20);
    }
    if (value <= 1000) {
        return ceilToStep(value, 50);
    }
    return ceilToStep(value, 100);
}

function pickByteScale(peakKb) {
    if (peakKb >= 1024 * 1024) {
        return { divisor: 1024 * 1024,
            suffix: "GB/s" };
    }
    if (peakKb >= 1024) {
        return { divisor: 1024,
            suffix: "MB/s" };
    }
    return { divisor: 1,
        suffix: "KB/s" };
}

function resolveCeiling(peak, maxY, allowGrowAboveMax) {
    let rawMax;
    let useGrowStep = false;
    if (maxY == null) {
        rawMax = Math.max(10, peak * 1.15);
    } else if (peak > maxY && allowGrowAboveMax) {
        rawMax = peak;
        useGrowStep = true;
    } else {
        rawMax = maxY;
    }
    if (maxY != null && rawMax === maxY) {
        return maxY;
    }
    if (useGrowStep) {
        return growStepCeil(rawMax);
    }
    return niceCeil(rawMax);
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
            // single-axis: [{ label, data, color }]
            // multi-axis : [{ label, data, color, yAxisID }]
        },
        unit: {
            type: String,
            default: "%",
        },
        maxY: {
            type: Number,
            default: null,
        },
        allowGrowAboveMax: {
            type: Boolean,
            default: false,
        },
        subValue: {
            type: String,
            default: "",
        },
        // Optional second line of context below the primary value
        // (e.g. compose limits / reservations).
        secondarySubValue: {
            type: String,
            default: "",
        },
        // When set, each dataset must carry a matching yAxisID. Renders one
        // y-axis per entry, with its own maxY / allowGrowAboveMax / unit.
        axes: {
            type: Array,
            default: () => [],
            // [{ id, position: 'left'|'right', maxY, allowGrowAboveMax, unit }]
        },
    },

    computed: {
        hasData() {
            return this.datasets.some(ds => ds.data && ds.data.length > 0);
        },

        scale() {
            if (this.unit === "auto-bytes") {
                const peak = Math.max(
                    0,
                    ...this.datasets.flatMap(ds => ds.data || []),
                );
                return pickByteScale(peak);
            }
            return { divisor: 1,
                suffix: this.unit };
        },

        // Per-dataset latest values shown in the header for multi-axis charts
        // (mspt left / tps right). Single-axis charts go through currentValue.
        perAxisValues() {
            if (!this.axes.length || this.datasets.length < 2) {
                return [];
            }
            return this.datasets.map(ds => {
                const axis = this.axes.find(a => a.id === ds.yAxisID);
                const data = ds.data || [];
                const v = data.length > 0 ? data[data.length - 1] : null;
                const unit = axis?.unit ?? "";
                const text = v == null
                    ? "—"
                    : `${v.toFixed(1)}${unit ? " " + unit : ""}`;
                return { label: ds.label,
                    text };
            });
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
            const { divisor, suffix } = this.scale;
            if (this.datasets.length === 1) {
                return (vals[0] / divisor).toFixed(1) + " " + suffix;
            }
            return this.datasets.map((ds, i) => {
                const v = vals[i] ?? 0;
                return `${ds.label}: ${(v / divisor).toFixed(1)} ${suffix}`;
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
                    pointHoverRadius: 0,
                    pointHitRadius: 0,
                    borderWidth: 2,
                    yAxisID: ds.yAxisID || "y",
                    // Let the stroke render a couple of pixels above the
                    // data area so a line that sits at the very top of
                    // the axis (e.g. TPS = 20) isn't sliced in half.
                    clip: { top: 4,
                        bottom: false,
                        left: false,
                        right: false },
                })),
            };
        },

        chartOptions() {
            const scales = { x: { display: false } };

            if (this.axes.length) {
                for (const axis of this.axes) {
                    const peak = Math.max(
                        0,
                        ...this.datasets
                            .filter(ds => ds.yAxisID === axis.id)
                            .flatMap(ds => ds.data || []),
                    );
                    const yMax = resolveCeiling(peak, axis.maxY ?? null, !!axis.allowGrowAboveMax);
                    const suffix = axis.unit ?? "";
                    scales[axis.id] = {
                        display: true,
                        position: axis.position || "left",
                        min: 0,
                        max: yMax,
                        border: { display: false },
                        grid: {
                            // Only the first axis draws gridlines so the
                            // chart background doesn't get a double grid.
                            display: axis === this.axes[0],
                            color: "rgba(255,255,255,0.05)",
                            drawTicks: false,
                        },
                        ticks: {
                            stepSize: yMax / 2,
                            font: { size: 9 },
                            color: "#888",
                            padding: 2,
                            callback(value) {
                                const n = Number(value);
                                const formatted = Number.isInteger(n) ? n : n.toFixed(1);
                                return suffix ? `${formatted}${suffix}` : `${formatted}`;
                            },
                        },
                    };
                }
            } else {
                const peak = Math.max(
                    0,
                    ...this.datasets.flatMap(ds => ds.data || []),
                );
                const yMax = resolveCeiling(peak, this.maxY, this.allowGrowAboveMax);
                const { divisor, suffix } = this.scale;
                scales.y = {
                    display: true,
                    min: 0,
                    max: yMax,
                    border: { display: false },
                    grid: {
                        color: "rgba(255,255,255,0.05)",
                        drawTicks: false,
                    },
                    ticks: {
                        stepSize: yMax / 2,
                        font: { size: 9 },
                        color: "#888",
                        padding: 2,
                        callback(value) {
                            const n = Number(value) / divisor;
                            const formatted = Number.isInteger(n) ? n : n.toFixed(1);
                            return `${formatted}${suffix}`;
                        },
                    },
                };
            }

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
                scales,
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

.mini-chart-value-split {
    justify-content: space-between;
}

.mini-chart-value-cell {
    font-size: 13px;
    font-weight: 500;
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;

    strong {
        color: $dark-font-color;
        font-weight: 600;
    }
}

.mini-chart-value-cell-end {
    text-align: right;
    margin-left: auto;
}

.mini-chart-sub {
    font-size: 12px;
    font-weight: 400;
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;
}

.mini-chart-sub-secondary {
    font-size: 11px;
    color: $dark-font-color3;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.3;
    margin-top: -1px;
}

.mini-chart-canvas-wrap {
    flex: 1 1 60px;
    min-height: 60px;
    position: relative;
}
</style>
