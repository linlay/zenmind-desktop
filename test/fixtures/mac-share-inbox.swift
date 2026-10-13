import Foundation
import Darwin

@main
enum ShareInboxAcceptance {
    static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !condition() { throw NSError(domain: "ShareInboxAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    static func expect(_ error: ShareInboxError, _ action: () throws -> Void) throws {
        do {
            try action()
            throw NSError(domain: "ShareInboxAcceptance", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected \(error)"])
        } catch let actual as ShareInboxError {
            try check(actual == error, "Unexpected error \(actual)")
        }
    }

    static func main() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("share-inbox-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let original = temporary.appendingPathComponent("微信聊天记录.zip")
        let originalData = Data([0x50, 0x4b, 0x03, 0x04, 0x61, 0x62, 0x63])
        try originalData.write(to: original)
        let inbox = temporary.appendingPathComponent("Inbox", isDirectory: true)
        let batch = try ShareInboxBatch(root: inbox)
        try batch.addFile(original)
        try batch.addData(Data("first".utf8), name: "share.txt")
        try batch.addData(Data("second".utf8), name: "share.txt")
        try batch.addData(Data("reserved".utf8), name: "manifest.json")
        try batch.addData(Data("safe".utf8), name: "../../path\\safe.txt")
        try batch.addData(Data("completed".utf8), name: ".completed.json")
        try batch.addData(Data("composed".utf8), name: "café.txt")
        try batch.addData(Data("decomposed".utf8), name: "cafe\u{301}.txt")
        try check(!FileManager.default.fileExists(atPath: inbox.appendingPathComponent(batch.id).path), "incomplete batch became visible")
        let id = try batch.publish()
        try check(id == batch.id && id == id.lowercased(), "batch identity must be a lowercase UUID")
        let directory = inbox.appendingPathComponent(id)
        let manifest = try JSONDecoder().decode(ShareInboxManifest.self, from: Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        try check(manifest.version == 1 && manifest.id == id, "incorrect manifest")
        try check(manifest.files.map { $0.name } == ["微信聊天记录.zip", "share.txt", "share (2).txt", "attachment", "safe.txt", "attachment (2)", "café.txt", "cafe\u{301} (2).txt"], "filenames are not safe or unique")
        try check(try Data(contentsOf: directory.appendingPathComponent("微信聊天记录.zip")) == originalData, "ZIP bytes changed")
        for entry in manifest.files {
            let file = directory.appendingPathComponent(entry.name)
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            try check((attributes[.size] as? NSNumber)?.int64Value == entry.sizeBytes, "manifest size mismatch")
            try check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "payload file must be private")
            try check(attributes[.type] as? FileAttributeType == .typeRegular, "payload file must be regular")
        }
        batch.cancellation.cancel()
        batch.discardStaging()
        try check(FileManager.default.fileExists(atPath: directory.path), "published data was deleted after cancellation")

        let tooMany = try ShareInboxBatch(root: inbox, limits: ShareInboxLimits(files: 2, bytes: 64))
        try tooMany.addData(Data([1]), name: "one")
        try tooMany.addData(Data([2]), name: "two")
        try expect(.tooManyFiles) { try tooMany.addData(Data([3]), name: "three") }
        tooMany.discardStaging()
        try check(!FileManager.default.fileExists(atPath: inbox.appendingPathComponent(tooMany.id).path), "rejected batch was published")

        let oversized = temporary.appendingPathComponent("oversized.zip")
        try Data(repeating: 0, count: 65).write(to: oversized)
        let limited = try ShareInboxBatch(root: inbox, limits: ShareInboxLimits(files: 16, bytes: 64))
        try expect(.tooLarge) { try limited.addFile(oversized) }
        try limited.addData(Data(repeating: 0, count: 40), name: "first")
        try expect(.tooLarge) { try limited.addData(Data(repeating: 0, count: 25), name: "second") }
        limited.discardStaging()

        let symlink = temporary.appendingPathComponent("link.zip")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: original)
        let failed = try ShareInboxBatch(root: inbox)
        try failed.addFile(original)
        try expect(.unreadable) { try failed.addFile(symlink) }
        try expect(.unreadable) { try failed.addFile(temporary) }
        try expect(.unreadable) { try failed.addFile(temporary.appendingPathComponent("missing")) }
        failed.discardStaging()
        try check(try Data(contentsOf: original) == originalData, "failure changed the original share")
        try check(!FileManager.default.fileExists(atPath: inbox.appendingPathComponent(".staging-\(failed.id)").path), "failed staging was not cleaned")

        let cancelled = try ShareInboxBatch(root: inbox)
        try cancelled.addData(Data([1]), name: "existing")
        cancelled.cancellation.cancel()
        try expect(.cancelled) { try cancelled.addFile(original) }
        try expect(.cancelled) { try cancelled.publish(); }
        cancelled.discardStaging()
        let empty = try ShareInboxBatch(root: inbox)
        try expect(.noItems) { try empty.publish(); }
        empty.discardStaging()
        try check(try FileManager.default.contentsOfDirectory(atPath: inbox.path) == [id], "unpublished directories were left behind")
        let linkedInbox = temporary.appendingPathComponent("LinkedInbox")
        try FileManager.default.createSymbolicLink(at: linkedInbox, withDestinationURL: inbox)
        try expect(.saveFailed) { _ = try ShareInboxBatch(root: linkedInbox) }
        print("MAC_SHARE_INBOX_ACCEPTANCE_OK: atomic batches, ZIP preservation, filenames, limits, cancellation, partial failure, symlinks")
    }
}
