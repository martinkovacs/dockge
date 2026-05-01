import { Router } from "../router";
import express, { Express, Router as ExpressRouter, Request, Response } from "express";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import path from "path";
import fs, { promises as fsAsync } from "fs";
import { log } from "../log";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import archiver from "archiver";

function getTokenFromRequest(req: Request): string | null {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
        return auth.slice(7);
    }
    if (req.query.token && typeof req.query.token === "string") {
        return req.query.token;
    }
    return null;
}

function checkAuth(req: Request, jwtSecret: string): boolean {
    const token = getTokenFromRequest(req);
    if (!token) {
        return false;
    }
    try {
        jwt.verify(token, jwtSecret);
        return true;
    } catch (_) {
        return false;
    }
}

function safePath(stackPath: string, relPath: string): string {
    const stackResolved = path.resolve(stackPath);
    const resolved = path.resolve(stackPath, relPath);
    if (!resolved.startsWith(stackResolved + path.sep) && resolved !== stackResolved) {
        throw new Error("Path traversal detected");
    }
    return resolved;
}

export class FileRouter extends Router {
    create(app: Express, server: DockgeServer): ExpressRouter {
        const router = express.Router();

        // Download file or directory (as ZIP)
        router.get("/api/files/:stackName/*", async (req: Request, res: Response) => {
            try {
                if (!checkAuth(req, server.jwtSecret)) {
                    res.status(401).json({ ok: false,
                        msg: "Unauthorized" });
                    return;
                }

                const stackName = req.params.stackName;
                const relPath = (req.params as Record<string, string>)[0] || "";

                let stack: Stack;
                try {
                    stack = await Stack.getStack(server, stackName);
                } catch (_) {
                    res.status(404).json({ ok: false,
                        msg: "Stack not found" });
                    return;
                }

                let targetPath: string;
                try {
                    targetPath = safePath(stack.path, relPath);
                } catch (_) {
                    res.status(400).json({ ok: false,
                        msg: "Invalid path" });
                    return;
                }

                if (!fs.existsSync(targetPath)) {
                    res.status(404).json({ ok: false,
                        msg: "File not found" });
                    return;
                }

                const stat = fs.statSync(targetPath);

                if (stat.isDirectory()) {
                    // Stream as ZIP
                    const dirName = path.basename(targetPath) || stackName;
                    res.setHeader("Content-Type", "application/zip");
                    res.setHeader("Content-Disposition", `attachment; filename="${dirName}.zip"`);

                    const archive = archiver("zip", { zlib: { level: 6 } });
                    archive.on("error", (err) => {
                        log.error("FileRouter", "Archive error: " + err.message);
                    });
                    archive.pipe(res);
                    archive.directory(targetPath, dirName);
                    await archive.finalize();
                } else {
                    // Stream file directly
                    const filename = path.basename(targetPath);
                    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
                    res.setHeader("Content-Type", "application/octet-stream");
                    res.setHeader("Content-Length", stat.size);
                    fs.createReadStream(targetPath).pipe(res);
                }
            } catch (e) {
                log.error("FileRouter", String(e));
                if (!res.headersSent) {
                    res.status(500).json({ ok: false,
                        msg: "Internal server error" });
                }
            }
        });

        // Upload files
        router.post("/api/files/:stackName/*", async (req: Request, res: Response) => {
            try {
                if (!checkAuth(req, server.jwtSecret)) {
                    res.status(401).json({ ok: false,
                        msg: "Unauthorized" });
                    return;
                }

                const stackName = req.params.stackName;
                const relPath = (req.params as Record<string, string>)[0] || "";

                let stack: Stack;
                try {
                    stack = await Stack.getStack(server, stackName);
                } catch (_) {
                    res.status(404).json({ ok: false,
                        msg: "Stack not found" });
                    return;
                }

                let targetDir: string;
                try {
                    targetDir = safePath(stack.path, relPath);
                } catch (_) {
                    res.status(400).json({ ok: false,
                        msg: "Invalid path" });
                    return;
                }

                // Ensure directory exists
                await fsAsync.mkdir(targetDir, { recursive: true });

                const bb = busboy({ headers: req.headers });
                const writes: Promise<void>[] = [];

                bb.on("file", (_field, file, info) => {
                    const filename = path.basename(info.filename);
                    const filePath = path.join(targetDir, filename);

                    const writePromise = new Promise<void>((resolve, reject) => {
                        const writeStream = fs.createWriteStream(filePath);
                        file.pipe(writeStream);
                        writeStream.on("finish", resolve);
                        writeStream.on("error", reject);
                    });
                    writes.push(writePromise);
                });

                bb.on("finish", async () => {
                    try {
                        await Promise.all(writes);
                        res.json({ ok: true });
                    } catch (e) {
                        res.status(500).json({ ok: false,
                            msg: String(e) });
                    }
                });

                bb.on("error", (e) => {
                    log.error("FileRouter", "Upload error: " + e);
                    if (!res.headersSent) {
                        res.status(500).json({ ok: false,
                            msg: String(e) });
                    }
                });

                req.pipe(bb);
            } catch (e) {
                log.error("FileRouter", String(e));
                if (!res.headersSent) {
                    res.status(500).json({ ok: false,
                        msg: "Internal server error" });
                }
            }
        });

        return router;
    }
}
