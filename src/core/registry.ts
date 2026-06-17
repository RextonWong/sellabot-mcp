/**
 * Platform registry. Tools call `registry.resolve(name)` to obtain a `Platform`
 * without knowing which concrete adapter backs it. Adding a platform = register
 * its adapter here; no tool changes.
 */
import { ValidationError } from "./errors.js";
import type { PlatformName } from "./models.js";
import type { Platform } from "./platform.js";

export class PlatformRegistry {
  private platforms = new Map<PlatformName, Platform>();

  register(platform: Platform): void {
    this.platforms.set(platform.name, platform);
  }

  resolve(name?: PlatformName): Platform {
    const target = name ?? this.defaultPlatform();
    const platform = this.platforms.get(target);
    if (!platform) {
      const available = [...this.platforms.keys()].join(", ") || "(none)";
      throw new ValidationError(
        `Platform "${target}" is not configured. Available: ${available}.`,
      );
    }
    return platform;
  }

  private defaultPlatform(): PlatformName {
    // Shopee is the v1 default; first registered wins if shopee absent.
    if (this.platforms.has("shopee")) return "shopee";
    const first = this.platforms.keys().next();
    if (first.done) throw new ValidationError("No platforms are configured.");
    return first.value;
  }

  list(): PlatformName[] {
    return [...this.platforms.keys()];
  }
}
