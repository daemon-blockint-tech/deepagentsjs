import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  isUnsafeIp,
  assertSafeHttpUrl,
  assertSafeLocalPath,
  safeFetch,
} from "./source-validation.js";

// ---------------------------------------------------------------------------
// isUnsafeIp
// ---------------------------------------------------------------------------

describe("isUnsafeIp", () => {
  it("rejects private IPv4 ranges", () => {
    expect(isUnsafeIp("10.0.0.1")).toBe(true);
    expect(isUnsafeIp("10.255.255.255")).toBe(true);
    expect(isUnsafeIp("172.16.0.1")).toBe(true);
    expect(isUnsafeIp("172.31.255.255")).toBe(true);
    expect(isUnsafeIp("192.168.1.1")).toBe(true);
    expect(isUnsafeIp("192.168.0.0")).toBe(true);
  });

  it("rejects loopback IPv4", () => {
    expect(isUnsafeIp("127.0.0.1")).toBe(true);
    expect(isUnsafeIp("127.255.255.255")).toBe(true);
    expect(isUnsafeIp("127.0.0.0")).toBe(true);
  });

  it("rejects 0.0.0.0/8", () => {
    expect(isUnsafeIp("0.0.0.0")).toBe(true);
    expect(isUnsafeIp("0.1.2.3")).toBe(true);
  });

  it("rejects link-local and cloud metadata (169.254.0.0/16)", () => {
    expect(isUnsafeIp("169.254.169.254")).toBe(true);
    expect(isUnsafeIp("169.254.0.1")).toBe(true);
    expect(isUnsafeIp("169.254.255.255")).toBe(true);
  });

  it("rejects CGNAT (100.64.0.0/10)", () => {
    expect(isUnsafeIp("100.64.0.1")).toBe(true);
    expect(isUnsafeIp("100.127.255.255")).toBe(true);
  });

  it("does NOT reject addresses just outside CGNAT", () => {
    expect(isUnsafeIp("100.63.255.255")).toBe(false);
    expect(isUnsafeIp("100.128.0.0")).toBe(false);
  });

  it("does NOT reject 172.15 or 172.32 (outside private range)", () => {
    expect(isUnsafeIp("172.15.0.1")).toBe(false);
    expect(isUnsafeIp("172.32.0.1")).toBe(false);
  });

  it("rejects IPv6 loopback and unspecified", () => {
    expect(isUnsafeIp("::1")).toBe(true);
    expect(isUnsafeIp("::")).toBe(true);
  });

  it("rejects IPv6 link-local (fe80::/10 prefix)", () => {
    // fe80::/10 covers first hextet 0xfe80..0xfebf.
    expect(isUnsafeIp("fe80::1")).toBe(true);
    expect(isUnsafeIp("fe80::1234")).toBe(true);
    expect(isUnsafeIp("fe90::1")).toBe(true);
    expect(isUnsafeIp("fea0::1")).toBe(true);
    expect(isUnsafeIp("feb0::1")).toBe(true);
    expect(isUnsafeIp("febf::1")).toBe(true);
  });

  it("rejects IPv6 site-local (fec0::/10 prefix)", () => {
    // fec0::/10 covers first hextet 0xfec0..0xfeff.
    expect(isUnsafeIp("fec0::1")).toBe(true);
    expect(isUnsafeIp("fed0::1")).toBe(true);
    expect(isUnsafeIp("fef0::1")).toBe(true);
    expect(isUnsafeIp("feff::1")).toBe(true);
  });

  it("does NOT reject IPv6 just outside fe80::/10 and fec0::/10", () => {
    // 0xfec0 is the start of site-local; 0xfe7f and below are global.
    expect(isUnsafeIp("fe7f::1")).toBe(false);
    expect(isUnsafeIp("fe00::1")).toBe(false);
  });

  it("rejects IPv6 unique-local (fc::/7)", () => {
    expect(isUnsafeIp("fc00::1")).toBe(true);
    expect(isUnsafeIp("fd00::1")).toBe(true);
    expect(isUnsafeIp("fd12:3456::1")).toBe(true);
  });

  it("rejects IPv4-mapped IPv6 addresses (dotted form)", () => {
    expect(isUnsafeIp("::ffff:127.0.0.1")).toBe(true);
    expect(isUnsafeIp("::ffff:169.254.169.254")).toBe(true);
    expect(isUnsafeIp("::ffff:10.0.0.1")).toBe(true);
    expect(isUnsafeIp("::ffff:192.168.1.1")).toBe(true);
  });

  it("rejects IPv4-mapped IPv6 addresses (hex form, as normalized by URL parser)", () => {
    // ::ffff:7f00:1 is the hex form of ::ffff:127.0.0.1
    expect(isUnsafeIp("::ffff:7f00:1")).toBe(true);
    // ::ffff:a9fe:a9fe is the hex form of ::ffff:169.254.169.254
    expect(isUnsafeIp("::ffff:a9fe:a9fe")).toBe(true);
    // ::ffff:a00:1 is the hex form of ::ffff:10.0.0.1
    expect(isUnsafeIp("::ffff:a00:1")).toBe(true);
  });

  it("does NOT reject IPv4-mapped public IPv6 addresses", () => {
    expect(isUnsafeIp("::ffff:8.8.8.8")).toBe(false);
    expect(isUnsafeIp("::ffff:1.1.1.1")).toBe(false);
    // hex form of ::ffff:8.8.8.8
    expect(isUnsafeIp("::ffff:808:808")).toBe(false);
  });

  it("does NOT reject public IPv4 addresses", () => {
    expect(isUnsafeIp("8.8.8.8")).toBe(false);
    expect(isUnsafeIp("1.1.1.1")).toBe(false);
    expect(isUnsafeIp("172.217.0.1")).toBe(false);
  });

  it("does NOT reject public IPv6 addresses", () => {
    expect(isUnsafeIp("2606:4700:4700::1111")).toBe(false);
    expect(isUnsafeIp("2001:4860:4860::8888")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertSafeHttpUrl
// ---------------------------------------------------------------------------

describe("assertSafeHttpUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeHttpUrl("file:///etc/passwd")).rejects.toThrow(
      /Unsupported protocol/,
    );
    await expect(assertSafeHttpUrl("ftp://example.com/file")).rejects.toThrow(
      /Unsupported protocol/,
    );
    await expect(assertSafeHttpUrl("gopher://127.0.0.1/abc")).rejects.toThrow(
      /Unsupported protocol/,
    );
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeHttpUrl("not-a-url")).rejects.toThrow(/Invalid URL/);
  });

  it("rejects literal unsafe IPv4 in URL", async () => {
    await expect(assertSafeHttpUrl("http://127.0.0.1/data")).rejects.toThrow(
      /unsafe host/,
    );
    await expect(
      assertSafeHttpUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/unsafe host/);
    await expect(assertSafeHttpUrl("http://10.0.0.1/data")).rejects.toThrow(
      /unsafe host/,
    );
    await expect(assertSafeHttpUrl("http://192.168.1.1/data")).rejects.toThrow(
      /unsafe host/,
    );
  });

  it("rejects literal unsafe IPv4-mapped IPv6 in URL", async () => {
    await expect(
      assertSafeHttpUrl("http://[::ffff:127.0.0.1]/data"),
    ).rejects.toThrow(/unsafe host/);
    await expect(
      assertSafeHttpUrl("http://[::ffff:169.254.169.254]/data"),
    ).rejects.toThrow(/unsafe host/);
  });

  it("accepts a URL with a safe literal public IP", async () => {
    // 8.8.8.8 is a public DNS resolver; dnsLookup on a literal IP
    // returns the IP itself without needing network access.
    const result = await assertSafeHttpUrl("http://8.8.8.8/data.csv");
    expect(result.url.hostname).toBe("8.8.8.8");
    expect(result.resolvedAddresses).toContain("8.8.8.8");
  });
});

// ---------------------------------------------------------------------------
// assertSafeLocalPath
// ---------------------------------------------------------------------------

describe("assertSafeLocalPath", () => {
  let tempDir: string;
  let ingestDir: string;
  let oldEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ingest-test-"));
    ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;
  });

  afterEach(async () => {
    process.env.INGEST_DATA_DIR = oldEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("accepts a file inside INGEST_DATA_DIR", async () => {
    const filePath = join(ingestDir, "data.csv");
    await writeFile(filePath, "a,b\n1,2\n");
    const safe = await assertSafeLocalPath(filePath);
    // Compare against realpath — on macOS /var is a symlink to /private/var
    expect(safe).toBe(await realpath(filePath));
  });

  it("accepts a file in a subdirectory of INGEST_DATA_DIR", async () => {
    const subDir = join(ingestDir, "sub");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "data.csv");
    await writeFile(filePath, "a,b\n1,2\n");
    const safe = await assertSafeLocalPath(filePath);
    expect(safe).toBe(await realpath(filePath));
  });

  it("rejects a path outside INGEST_DATA_DIR (path traversal)", async () => {
    await expect(assertSafeLocalPath("/etc/passwd")).rejects.toThrow(
      /outside INGEST_DATA_DIR/,
    );
    await expect(
      assertSafeLocalPath(join(tempDir, "..", "secret")),
    ).rejects.toThrow(/outside INGEST_DATA_DIR/);
  });

  it("rejects ../ traversal that escapes INGEST_DATA_DIR", async () => {
    const filePath = join(ingestDir, "..", "escape.csv");
    await expect(assertSafeLocalPath(filePath)).rejects.toThrow(
      /outside INGEST_DATA_DIR/,
    );
  });

  it("rejects a symlink inside INGEST_DATA_DIR that points outside", async () => {
    // Create a secret file outside the ingest dir
    const secretPath = join(tempDir, "secret.txt");
    await writeFile(secretPath, "secret");

    // Create a symlink inside the ingest dir pointing to the secret
    const symlinkPath = join(ingestDir, "link.csv");
    await symlink(secretPath, symlinkPath);

    await expect(assertSafeLocalPath(symlinkPath)).rejects.toThrow(
      /outside INGEST_DATA_DIR/,
    );
  });

  it("accepts a symlink inside INGEST_DATA_DIR that points within it", async () => {
    const realFile = join(ingestDir, "real.csv");
    await writeFile(realFile, "a,b\n1,2\n");
    const symlinkPath = join(ingestDir, "link.csv");
    await symlink(realFile, symlinkPath);

    const safe = await assertSafeLocalPath(symlinkPath);
    expect(safe).toBe(await realpath(realFile));
  });

  it("throws when INGEST_DATA_DIR is not set", async () => {
    delete process.env.INGEST_DATA_DIR;
    await expect(assertSafeLocalPath("/tmp/anyfile")).rejects.toThrow(
      /INGEST_DATA_DIR/,
    );
  });

  it("resolves a relative path against INGEST_DATA_DIR (not cwd) when the file is missing", async () => {
    // A relative path that does not exist anywhere. The ENOENT fallback
    // must resolve it against INGEST_DATA_DIR, so the containment check
    // passes and the caller gets a clear "file not found" from readFile
    // rather than a confusing "outside INGEST_DATA_DIR" error.
    const safe = await assertSafeLocalPath("missing.csv");
    // Compare against the realpath-resolved base (on macOS /var → /private/var).
    const expectedBase = await realpath(ingestDir);
    expect(safe).toBe(join(expectedBase, "missing.csv"));
  });

  it("rejects a relative ../ traversal that would escape INGEST_DATA_DIR", async () => {
    // Relative path with ../ that escapes the ingest dir. Even though
    // the file doesn't exist, the lexical resolution against
    // INGEST_DATA_DIR must produce a path outside the base and be
    // rejected by the containment check.
    await expect(assertSafeLocalPath("../escape.csv")).rejects.toThrow(
      /outside INGEST_DATA_DIR/,
    );
  });
});

// ---------------------------------------------------------------------------
// safeFetch — redirect handling
// ---------------------------------------------------------------------------

describe("safeFetch", () => {
  it("rejects a URL with an unsafe literal IP directly", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/unsafe host/);
  });

  it("rejects a redirect to an unsafe host", async () => {
    // Mock global fetch so we don't need a real server.
    // The initial URL uses a safe public literal IP (8.8.8.8) so
    // assertSafeHttpUrl passes. The mocked fetch returns a 302
    // redirect to an unsafe metadata endpoint. safeFetch must
    // re-validate the redirect target and reject it.
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn((_url: string, _init?: unknown) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: {
              Location: "http://169.254.169.254/latest/meta-data/",
            },
          }),
        );
      }
      return Promise.resolve(new Response("should not reach"));
    }) as typeof fetch;

    try {
      await expect(safeFetch("http://8.8.8.8/data")).rejects.toThrow(
        /unsafe host/,
      );
      expect(callCount).toBe(1); // only the initial fetch, not the redirect
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a redirect to an unsafe IPv4-mapped IPv6 host", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn((_url: string, _init?: unknown) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "http://[::ffff:127.0.0.1]/secret" },
          }),
        );
      }
      return Promise.resolve(new Response("should not reach"));
    }) as typeof fetch;

    try {
      await expect(safeFetch("http://8.8.8.8/data")).rejects.toThrow(
        /unsafe host/,
      );
      expect(callCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("follows a redirect to a safe host", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn((_url: string, _init?: unknown) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "http://8.8.8.8/redirected" },
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;

    try {
      const res = await safeFetch("http://8.8.8.8/initial");
      expect(callCount).toBe(2);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects after too many redirects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_url: string, _init?: unknown) => {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "http://8.8.8.8/loop" },
        }),
      );
    }) as typeof fetch;

    try {
      await expect(safeFetch("http://8.8.8.8/start", {}, 3)).rejects.toThrow(
        /Too many redirects/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strips Authorization/Cookie headers on cross-host redirects", async () => {
    const originalFetch = globalThis.fetch;
    const capturedInit: RequestInit[] = [];
    let callCount = 0;
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      callCount++;
      capturedInit.push(init ?? {});
      if (callCount === 1) {
        // Redirect from 8.8.8.8 to 1.1.1.1 (different host).
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "http://1.1.1.1/redirected" },
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;

    try {
      await safeFetch("http://8.8.8.8/initial", {
        headers: {
          Authorization: "Bearer secret-token",
          Cookie: "session=abc",
          "X-API-Key": "key123",
          "X-Custom": "keep-me",
          Accept: "application/json",
        },
      });
      expect(callCount).toBe(2);
      // First hop retains all headers.
      const firstHeaders = capturedInit[0]?.headers as Record<string, string>;
      expect(firstHeaders.Authorization).toBe("Bearer secret-token");
      expect(firstHeaders.Cookie).toBe("session=abc");
      // Second hop (cross-host) must strip sensitive headers.
      const secondHeaders = capturedInit[1]?.headers as Record<string, string>;
      expect(secondHeaders.Authorization).toBeUndefined();
      expect(secondHeaders.Cookie).toBeUndefined();
      expect(secondHeaders["X-API-Key"]).toBeUndefined();
      // Non-sensitive headers are preserved.
      expect(secondHeaders["X-Custom"]).toBe("keep-me");
      expect(secondHeaders.Accept).toBe("application/json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves Authorization/Cookie headers on same-host redirects", async () => {
    const originalFetch = globalThis.fetch;
    const capturedInit: RequestInit[] = [];
    let callCount = 0;
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      callCount++;
      capturedInit.push(init ?? {});
      if (callCount === 1) {
        // Same-host redirect (path change only).
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "http://8.8.8.8/redirected" },
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;

    try {
      await safeFetch("http://8.8.8.8/initial", {
        headers: { Authorization: "Bearer secret-token" },
      });
      expect(callCount).toBe(2);
      const secondHeaders = capturedInit[1]?.headers as Record<string, string>;
      // Same host → headers preserved.
      expect(secondHeaders.Authorization).toBe("Bearer secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
