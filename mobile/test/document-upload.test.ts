import { describe, expect, it, vi } from "vitest";
import { uploadDocumentContent } from "../src/document-upload";

const input = {
  uploadUrl: "https://api.example.test/me/documents/document-1/content",
  token: "session-token",
  contentType: "application/pdf",
  body: new Blob(["resume"]),
};

describe("document content upload", () => {
  it("keeps metadata after a successful content upload", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const deleteMetadata = vi.fn(async () => undefined);

    await uploadDocumentContent(input, { fetcher, deleteMetadata });

    expect(deleteMetadata).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(input.uploadUrl, expect.objectContaining({
      method: "PUT",
      headers: { "Content-Type": "application/pdf", Authorization: "Bearer session-token" },
      body: input.body,
    }));
  });

  it.each([413, 429])("removes metadata and surfaces an HTTP %s upload failure", async (status) => {
    const fetcher = vi.fn(async () => Response.json({ message: "Upload rejected" }, { status }));
    const deleteMetadata = vi.fn(async () => undefined);

    await expect(uploadDocumentContent(input, { fetcher, deleteMetadata })).rejects.toThrow("Upload rejected");
    expect(deleteMetadata).toHaveBeenCalledOnce();
  });

  it("removes metadata after a network failure", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network unavailable"); });
    const deleteMetadata = vi.fn(async () => undefined);

    await expect(uploadDocumentContent(input, { fetcher, deleteMetadata })).rejects.toThrow("network unavailable");
    expect(deleteMetadata).toHaveBeenCalledOnce();
  });
});
