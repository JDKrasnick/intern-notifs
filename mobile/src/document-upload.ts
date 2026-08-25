type UploadDocumentInput = {
  uploadUrl: string;
  token: string;
  contentType: string;
  body: Blob;
};

type UploadDocumentDependencies = {
  fetcher?: typeof fetch;
  deleteMetadata: () => Promise<unknown>;
};

async function uploadError(response: Response): Promise<Error> {
  const fallback = `Document upload failed (HTTP ${response.status})`;
  try {
    const value = await response.json() as { message?: unknown };
    return new Error(typeof value.message === "string" && value.message ? value.message : fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function uploadDocumentContent(
  input: UploadDocumentInput,
  dependencies: UploadDocumentDependencies,
): Promise<void> {
  try {
    const response = await (dependencies.fetcher ?? fetch)(input.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        Authorization: `Bearer ${input.token}`,
      },
      body: input.body,
    });
    if (!response.ok) throw await uploadError(response);
  } catch (error) {
    await dependencies.deleteMetadata().catch(() => undefined);
    throw error;
  }
}
