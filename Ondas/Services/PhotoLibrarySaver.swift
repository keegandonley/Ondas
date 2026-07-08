import Photos
import UIKit

/// Saves a generated image to the user's Photos library using add-only authorization (the
/// minimal permission — the app never reads or lists the user's library). Shared by the in-chat
/// image context menu and the full-screen viewer so there's a single save path.
enum PhotoLibrarySaver {
    enum SaveResult: Equatable {
        case saved
        /// The user denied (or has previously denied) add-only access. The caller should point them
        /// at Settings.
        case denied
        /// The image bytes couldn't be written (corrupt data or a Photos error).
        case failed
    }

    /// Requests add-only access if needed, then writes `imageData` as a new photo asset. Returns the
    /// outcome so the caller can show appropriate feedback.
    static func save(_ imageData: Data) async -> SaveResult {
        let status = await requestAddOnlyAuthorization()
        guard status == .authorized || status == .limited else {
            return .denied
        }

        do {
            try await PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: imageData, options: nil)
            }
            return .saved
        } catch {
            return .failed
        }
    }

    private static func requestAddOnlyAuthorization() async -> PHAuthorizationStatus {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        guard current == .notDetermined else { return current }
        return await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    }
}
