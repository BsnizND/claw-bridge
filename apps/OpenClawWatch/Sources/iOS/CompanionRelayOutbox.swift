import Foundation

struct CompanionRelayOutboxItem: Codable, Equatable, Identifiable {
    var id: String
    var audioFileName: String
    var metadata: [String: String]
    var createdAt: Date
    var attemptCount: Int
    var lastAttemptAt: Date?
    var lastError: String?
}

@MainActor
final class CompanionRelayOutbox {
    private let fileManager: FileManager
    private let directory: URL
    private let manifestURL: URL
    private let removeAudioFile: (URL) throws -> Void
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init(
        fileManager: FileManager = .default,
        directory: URL? = nil,
        removeAudioFile: ((URL) throws -> Void)? = nil
    ) {
        self.fileManager = fileManager
        let baseDirectory = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        self.directory = directory ?? baseDirectory
            .appending(path: "ClawBridge", directoryHint: .isDirectory)
            .appending(path: "WatchRelayOutbox", directoryHint: .isDirectory)
        manifestURL = self.directory.appending(path: "manifest.json")
        self.removeAudioFile = removeAudioFile ?? { try fileManager.removeItem(at: $0) }
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? fileManager.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    func items() throws -> [CompanionRelayOutboxItem] {
        try loadItems()
    }

    func enqueue(fileURL: URL, metadata: [String: String]) throws -> CompanionRelayOutboxItem {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var items = try loadItems()
        let id = UUID().uuidString
        let fileExtension = fileURL.pathExtension.isEmpty ? "m4a" : fileURL.pathExtension
        let audioFileName = "\(id).\(fileExtension)"
        let destination = directory.appending(path: audioFileName)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: fileURL, to: destination)
        let item = CompanionRelayOutboxItem(
            id: id,
            audioFileName: audioFileName,
            metadata: metadata,
            createdAt: Date(),
            attemptCount: 0,
            lastAttemptAt: nil,
            lastError: nil
        )
        items.append(item)
        do {
            try saveItems(items)
        } catch {
            try? fileManager.removeItem(at: destination)
            throw error
        }
        return item
    }

    func audioURL(for item: CompanionRelayOutboxItem) -> URL {
        directory.appending(path: item.audioFileName)
    }

    func markFailed(id: String, error: String) throws {
        var items = try loadItems()
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].attemptCount += 1
        items[index].lastAttemptAt = Date()
        items[index].lastError = error
        try saveItems(items)
    }

    func remove(id: String) throws {
        var items = try loadItems()
        guard let item = items.first(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }
        try saveItems(items)

        // The manifest is the durable queue authority. Commit dequeue before
        // best-effort payload cleanup so a deletion error cannot resurrect a
        // request whose bridge receipt was already accepted.
        let audioURL = audioURL(for: item)
        if fileManager.fileExists(atPath: audioURL.path) {
            try? removeAudioFile(audioURL)
        }
    }

    private func loadItems() throws -> [CompanionRelayOutboxItem] {
        guard fileManager.fileExists(atPath: manifestURL.path) else { return [] }
        let data = try Data(contentsOf: manifestURL)
        return try decoder.decode([CompanionRelayOutboxItem].self, from: data)
    }

    private func saveItems(_ items: [CompanionRelayOutboxItem]) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(items)
        try data.write(to: manifestURL, options: .atomic)
    }
}
