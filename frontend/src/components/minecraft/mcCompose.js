// Helpers for reading Minecraft-relevant values out of a parsed compose
// services map. Used by MinecraftLimits (the editor) and MinecraftConsole
// (the read-only summary in the first stats card).

function getService(jsonConfig, serviceName) {
    return jsonConfig?.services?.[serviceName] || null;
}

export function readResourceLimits(jsonConfig, serviceName) {
    const out = { cpuLimit: "",
        cpuReservation: "",
        memLimit: "",
        memReservation: "" };
    const svc = getService(jsonConfig, serviceName);
    if (!svc) {
        return out;
    }
    const limits = svc.deploy?.resources?.limits || {};
    const reservations = svc.deploy?.resources?.reservations || {};
    if (limits.cpus != null) {
        out.cpuLimit = String(limits.cpus);
    }
    if (limits.memory != null) {
        out.memLimit = String(limits.memory);
    }
    if (reservations.cpus != null) {
        out.cpuReservation = String(reservations.cpus);
    }
    if (reservations.memory != null) {
        out.memReservation = String(reservations.memory);
    }
    return out;
}

// compose `environment:` may be a map ({KEY: VAL}) or a sequence
// (["KEY=VAL"]). Normalise to a plain object.
export function readEnvMap(jsonConfig, serviceName) {
    const svc = getService(jsonConfig, serviceName);
    const env = svc?.environment;
    if (!env) {
        return {};
    }
    if (Array.isArray(env)) {
        const map = {};
        for (const entry of env) {
            if (typeof entry !== "string") {
                continue;
            }
            const eq = entry.indexOf("=");
            if (eq === -1) {
                map[entry] = "";
            } else {
                map[entry.slice(0, eq)] = entry.slice(eq + 1);
            }
        }
        return map;
    }
    if (typeof env === "object") {
        const map = {};
        for (const [ k, v ] of Object.entries(env)) {
            map[k] = v == null ? "" : String(v);
        }
        return map;
    }
    return {};
}

export function readJvmMemory(jsonConfig, serviceName) {
    const env = readEnvMap(jsonConfig, serviceName);
    return {
        initMemory: env.INIT_MEMORY || "",
        maxMemory: env.MAX_MEMORY || "",
    };
}
