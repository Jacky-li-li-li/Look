// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecretStorageWarning from "../src/renderer/components/settings/SecretStorageWarning";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

function mockStatus(status: { secure: boolean; backend: string | null; plaintextFallbackUsed: boolean }) {
	Object.defineProperty(window, "look", {
		configurable: true,
		value: { getSecretStorageStatus: vi.fn().mockResolvedValue({ success: true, status }) },
	});
}

describe("SecretStorageWarning", () => {
	it("renders a warning when storage is not secure", async () => {
		mockStatus({ secure: false, backend: "basic_text", plaintextFallbackUsed: false });
		render(<SecretStorageWarning />);
		await waitFor(() => expect(screen.getByTestId("secret-storage-warning")).toBeTruthy());
		expect(screen.getByText("settings.secretStorageInsecure")).toBeTruthy();
	});

	it("renders a warning when a plaintext fallback happened", async () => {
		mockStatus({ secure: true, backend: null, plaintextFallbackUsed: true });
		render(<SecretStorageWarning />);
		await waitFor(() => expect(screen.getByTestId("secret-storage-warning")).toBeTruthy());
	});

	it("renders nothing when encryption is healthy", async () => {
		mockStatus({ secure: true, backend: null, plaintextFallbackUsed: false });
		const { container } = render(<SecretStorageWarning />);
		await waitFor(() => expect(window.look.getSecretStorageStatus).toHaveBeenCalled());
		expect(container.innerHTML).toBe("");
	});
});
