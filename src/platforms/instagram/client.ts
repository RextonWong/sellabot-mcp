const GRAPH_BASE = "https://graph.facebook.com/v21.0";

interface GraphError {
  error: { message: string; type: string; code: number };
}

export class InstagramClient {
  constructor(
    private readonly accessToken: string,
    private readonly igUserId: string,
  ) {}

  async postPhoto(imageUrl: string, caption: string): Promise<string> {
    // Step 1: Create media container
    const createRes = await fetch(`${GRAPH_BASE}/${this.igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl,
        caption,
        access_token: this.accessToken,
      }),
    });
    const createData = (await createRes.json()) as { id?: string } & Partial<GraphError>;
    if (!createRes.ok || !createData.id) {
      throw new Error(
        createData.error?.message ?? `Failed to create media container (${createRes.status})`,
      );
    }

    // Step 2: Wait until container is ready
    await this.waitForContainer(createData.id);

    // Step 3: Publish
    const publishRes = await fetch(`${GRAPH_BASE}/${this.igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: createData.id,
        access_token: this.accessToken,
      }),
    });
    const publishData = (await publishRes.json()) as { id?: string } & Partial<GraphError>;
    if (!publishRes.ok || !publishData.id) {
      throw new Error(
        publishData.error?.message ?? `Failed to publish media (${publishRes.status})`,
      );
    }

    return publishData.id;
  }

  private async waitForContainer(containerId: string, maxWaitMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const res = await fetch(
        `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${this.accessToken}`,
      );
      const data = (await res.json()) as { status_code?: string };
      if (data.status_code === "FINISHED") return;
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        throw new Error(`Media container in state: ${data.status_code}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("Media container did not finish processing in time");
  }

  /** Returns ms timestamp of token expiry, or null if token is invalid/non-expiring. */
  async getTokenExpiryMs(): Promise<number | null> {
    try {
      const url = new URL(`${GRAPH_BASE}/debug_token`);
      url.searchParams.set("input_token", this.accessToken);
      url.searchParams.set("access_token", this.accessToken);
      const res = await fetch(url.toString());
      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: { expires_at?: number; is_valid?: boolean };
      };
      if (!data.data?.is_valid) return null;
      return data.data.expires_at ? data.data.expires_at * 1000 : null;
    } catch {
      return null;
    }
  }
}
