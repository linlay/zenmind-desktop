import Foundation
import Darwin

struct ShareInboxLimits {
    let files: Int
    let bytes: Int64
    static let standard = ShareInboxLimits(files: 16, bytes: 256 * 1024 * 1024)
}

enum ShareInboxError: Error, Equatable {
    case cancelled
    case noItems
    case tooManyFiles
    case tooLarge
    case unreadable
    case unsupported
    case saveFailed
}

final class ShareCancellation {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func check() throws {
        lock.lock()
        let value = cancelled
        lock.unlock()
        if value { throw ShareInboxError.cancelled }
    }
}

struct ShareInboxFile: Codable {
    let name: String
    let sizeBytes: Int64
}

struct ShareInboxManifest: Codable {
    let version: Int
    let id: String
    let files: [ShareInboxFile]
}

// The extension writes only to its own sandbox. A batch becomes visible to the
// containing app in one rename, after every provider has been read successfully.
final class ShareInboxBatch {
    let id = UUID().uuidString.lowercased()
    let cancellation: ShareCancellation
    private let lock = NSLock()
    private let root: URL
    private let staging: URL
    private let limits: ShareInboxLimits
    private var entries: [ShareInboxFile] = []
    private var bytes: Int64 = 0
    private var published = false

    init(root: URL? = nil, limits: ShareInboxLimits = .standard,
         cancellation: ShareCancellation = ShareCancellation()) throws {
        self.cancellation = cancellation
        self.limits = limits
        let support = try root ?? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("ShareInbox", isDirectory: true)
        self.root = support
        self.staging = support.appendingPathComponent(".staging-\(id)", isDirectory: true)
        try Self.ensureDirectory(support)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
    }

    private static func ensureDirectory(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw ShareInboxError.saveFailed
            }
        } else {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
        }
    }

    private func nextName(_ proposed: String, fallback: String) -> String {
        var name = proposed.components(separatedBy: CharacterSet(charactersIn: "/\\"))
            .last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        name = name.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? "_" : String($0) }.joined()
        let reserved: Set<String> = ["manifest.json", ".completed.json"]
        if name.isEmpty || name == "." || name == ".." || reserved.contains(name.lowercased()) {
            name = fallback
        }
        // Keep names portable and below NAME_MAX, including a collision suffix.
        while name.utf8.count > 220 { name.removeLast() }
        let file = name as NSString
        let ext = file.pathExtension
        let stem = ext.isEmpty ? name : file.deletingPathExtension
        var candidate = name
        var index = 2
        let used = Set(entries.map { $0.name.decomposedStringWithCanonicalMapping.lowercased() })
        while used.contains(candidate.decomposedStringWithCanonicalMapping.lowercased()) || reserved.contains(candidate.lowercased()) {
            candidate = "\(stem) (\(index))\(ext.isEmpty ? "" : ".\(ext)")"
            index += 1
        }
        return candidate
    }

    private func reserveName(_ proposed: String, fallback: String) throws -> String {
        try cancellation.check()
        guard !published else { throw ShareInboxError.saveFailed }
        guard entries.count < limits.files else { throw ShareInboxError.tooManyFiles }
        return nextName(proposed, fallback: fallback)
    }

    func addFile(_ source: URL, suggestedName: String? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        guard source.isFileURL else { throw ShareInboxError.unsupported }
        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }
        let descriptor = Darwin.open(source.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ShareInboxError.unreadable }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            throw ShareInboxError.unreadable
        }
        guard info.st_size >= 0, Int64(info.st_size) <= limits.bytes - bytes else {
            throw ShareInboxError.tooLarge
        }
        let name = try reserveName(suggestedName ?? source.lastPathComponent, fallback: "attachment")
        let target = staging.appendingPathComponent(name, isDirectory: false)
        let output = try outputFile(target)
        defer { try? output.close() }
        var copied: Int64 = 0
        do {
            while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
                try cancellation.check()
                guard Int64(data.count) <= limits.bytes - bytes - copied else { throw ShareInboxError.tooLarge }
                try output.write(contentsOf: data)
                copied += Int64(data.count)
            }
            try cancellation.check()
            // A mutable input must not silently turn into an incomplete share.
            guard copied == Int64(info.st_size) else { throw ShareInboxError.unreadable }
            try output.synchronize()
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
        entries.append(ShareInboxFile(name: name, sizeBytes: copied))
        bytes += copied
    }

    func addData(_ data: Data, name proposed: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let name = try reserveName(proposed, fallback: "attachment")
        guard Int64(data.count) <= limits.bytes - bytes else { throw ShareInboxError.tooLarge }
        let target = staging.appendingPathComponent(name, isDirectory: false)
        let output = try outputFile(target)
        defer { try? output.close() }
        do {
            try cancellation.check()
            try output.write(contentsOf: data)
            try output.synchronize()
            try cancellation.check()
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
        entries.append(ShareInboxFile(name: name, sizeBytes: Int64(data.count)))
        bytes += Int64(data.count)
    }

    private func outputFile(_ target: URL) throws -> FileHandle {
        let descriptor = Darwin.open(target.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ShareInboxError.saveFailed }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    func publish() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        try cancellation.check()
        guard !entries.isEmpty else { throw ShareInboxError.noItems }
        if published { return id }
        let manifest = ShareInboxManifest(version: 1, id: id, files: entries)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let output = try outputFile(staging.appendingPathComponent("manifest.json"))
        defer { try? output.close() }
        try output.write(contentsOf: encoder.encode(manifest))
        try output.synchronize()
        try cancellation.check()
        try FileManager.default.moveItem(at: staging, to: root.appendingPathComponent(id, isDirectory: true))
        published = true
        return id
    }

    func discardStaging() {
        lock.lock()
        defer { lock.unlock() }
        if !published { try? FileManager.default.removeItem(at: staging) }
    }

    func publishedSnapshot() throws -> (directory: URL, manifest: ShareInboxManifest) {
        lock.lock()
        defer { lock.unlock() }
        guard published else { throw ShareInboxError.saveFailed }
        return (root.appendingPathComponent(id, isDirectory: true), ShareInboxManifest(version: 1, id: id, files: entries))
    }
}
