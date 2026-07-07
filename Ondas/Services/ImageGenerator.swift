import CoreGraphics
import Foundation
import ImageIO
import ImagePlayground
import UniformTypeIdentifiers

/// Wraps the on-device image-generation model (`ImageCreator`, from ImagePlayground) and
/// returns JPEG-encoded `Data` ready to store on a `ChatMessage`.
enum ImageGenerator {
    enum GenerationError: LocalizedError {
        case unavailable
        case emptyPrompt
        case noImageProduced
        case encodingFailed

        var errorDescription: String? {
            switch self {
            case .unavailable:
                return "On-device image generation isn't available on this device."
            case .emptyPrompt:
                return "Describe the image you'd like me to create."
            case .noImageProduced:
                return "No image was generated. Try describing it differently."
            case .encodingFailed:
                return "The generated image couldn't be saved."
            }
        }
    }

    /// JPEG quality for stored generated images. High enough to look clean, low enough to
    /// keep CloudKit sync payloads small.
    private static let compressionQuality: CGFloat = 0.86

    /// Generates a single image from `prompt` and returns it as JPEG data. Throws a
    /// `GenerationError` when the model is unavailable or produces nothing usable.
    static func generate(prompt: String) async throws -> Data {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw GenerationError.emptyPrompt }

        // `ImageCreator()` throws when the device or OS can't run the generator; surface
        // that as our own `unavailable` so the UI shows a friendly message.
        let creator: ImageCreator
        do {
            creator = try await ImageCreator()
        } catch {
            throw GenerationError.unavailable
        }

        // Prefer the illustration style when offered; otherwise take whatever the device
        // supports. An empty style list means the generator can't run here.
        guard let style = creator.availableStyles.first(where: { $0 == .illustration })
            ?? creator.availableStyles.first
        else {
            throw GenerationError.unavailable
        }

        let images = creator.images(for: [.text(trimmed)], style: style, limit: 1)
        for try await image in images {
            return try encodeJPEG(image.cgImage)
        }
        throw GenerationError.noImageProduced
    }

    private static func encodeJPEG(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw GenerationError.encodingFailed
        }
        CGImageDestinationAddImage(destination, image, [
            kCGImageDestinationLossyCompressionQuality: compressionQuality
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw GenerationError.encodingFailed
        }
        return data as Data
    }
}
