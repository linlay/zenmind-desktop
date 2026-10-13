import Foundation
import Security
import Darwin

enum ShareTransferError: Error {
    case cannotListen
    case timedOut
    case cannotRead
}

// A temporary capability server avoids asking the Electron app to enter another
// app's protected data container. It owns no network client entitlement, listens
// only on loopback, and serves exactly one immutable, already-published batch.
final class ShareLoopbackServer {
    let port: Int
    let ticket: String
    private let ticketBytes: [UInt8]
    private let batchID: String
    private let directory: URL
    private let files: [ShareInboxFile]
    private let manifestData: Data
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "desktop.share.transfer", qos: .userInitiated)
    private var listener: Int32
    private var connection: Int32 = -1
    private var stopped = false
    private var started = false
    private var watchdog: DispatchWorkItem?
    private var completed: (() -> Void)?
    private var failed: ((ShareTransferError) -> Void)?

    init(batch: ShareInboxBatch) throws {
        let snapshot = try batch.publishedSnapshot()
        directory = snapshot.directory
        files = snapshot.manifest.files
        batchID = snapshot.manifest.id
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        manifestData = try encoder.encode(snapshot.manifest)
        guard !files.isEmpty, files.count <= 16, manifestData.count <= 64 * 1024 else {
            throw ShareTransferError.cannotRead
        }
        var secret = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, secret.count, &secret) == errSecSuccess else {
            throw ShareTransferError.cannotListen
        }
        ticket = Data(secret).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        ticketBytes = Array(ticket.utf8)
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw ShareTransferError.cannotListen }
        listener = socket
        _ = fcntl(socket, F_SETFD, FD_CLOEXEC)
        var noSignal: Int32 = 1
        _ = setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(socket, 4) == 0 else {
            Darwin.close(socket)
            throw ShareTransferError.cannotListen
        }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let identified = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(socket, $0, &length)
            }
        }
        guard identified == 0, address.sin_addr.s_addr == inet_addr("127.0.0.1") else {
            Darwin.close(socket)
            throw ShareTransferError.cannotListen
        }
        port = Int(UInt16(bigEndian: address.sin_port))
        guard port > 0 else { Darwin.close(socket); throw ShareTransferError.cannotListen }
    }

    func start(onCompleted: @escaping () -> Void, onFailure: @escaping (ShareTransferError) -> Void) {
        lock.lock()
        guard !started, !stopped else { lock.unlock(); return }
        started = true
        completed = onCompleted
        failed = onFailure
        let timeout = DispatchWorkItem { [weak self] in self?.finish(error: .timedOut) }
        watchdog = timeout
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 120, execute: timeout)
        queue.async { [self] in serve() }
    }

    func stop() { terminate(notify: false, error: nil) }

    private func finish(error: ShareTransferError?) { terminate(notify: true, error: error) }

    private func terminate(notify: Bool, error: ShareTransferError?) {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true
        let socket = listener
        listener = -1
        let client = connection
        watchdog?.cancel()
        watchdog = nil
        let success = completed
        let failure = failed
        completed = nil
        failed = nil
        lock.unlock()
        if client >= 0 { _ = shutdown(client, SHUT_RDWR) }
        if socket >= 0 {
            _ = shutdown(socket, SHUT_RDWR)
            Darwin.close(socket)
        }
        if notify {
            if let error { failure?(error) }
            else { success?() }
        }
    }

    private func currentListener() -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        return stopped ? -1 : listener
    }

    private func serve() {
        while true {
            let socket = currentListener()
            if socket < 0 { return }
            let client = Darwin.accept(socket, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                if currentListener() >= 0 { finish(error: .cannotListen) }
                return
            }
            lock.lock()
            if stopped { lock.unlock(); Darwin.close(client); return }
            connection = client
            lock.unlock()
            _ = fcntl(client, F_SETFD, FD_CLOEXEC)
            var noSignal: Int32 = 1
            _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var timeout = timeval(tv_sec: 5, tv_usec: 0)
            _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            _ = setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let acknowledged = respond(to: client)
            lock.lock()
            connection = -1
            lock.unlock()
            Darwin.close(client)
            if acknowledged { finish(error: nil); return }
        }
    }

    private func authenticates(_ supplied: String?) -> Bool {
        guard let supplied else { return false }
        let candidate = Array(supplied.utf8)
        guard candidate.count == ticketBytes.count else { return false }
        var difference: UInt8 = 0
        for index in ticketBytes.indices { difference |= candidate[index] ^ ticketBytes[index] }
        return difference == 0
    }

    private func request(_ socket: Int32) -> (method: String, path: String, headers: [String: String])? {
        var data = Data()
        let terminator = Data([13, 10, 13, 10])
        var buffer = [UInt8](repeating: 0, count: 1024)
        while data.count <= 8192 {
            let count = Darwin.recv(socket, &buffer, buffer.count, 0)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return nil }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= 8192 else { return nil }
            guard let end = data.range(of: terminator) else { continue }
            // No request body, transfer coding or pipelined request is accepted.
            guard end.upperBound == data.endIndex,
                  let text = String(data: data.prefix(end.lowerBound), encoding: .utf8) else { return nil }
            let lines = text.components(separatedBy: "\r\n")
            let parts = lines[0].split(separator: " ")
            guard parts.count == 3, parts[2] == "HTTP/1.1", ["GET", "POST"].contains(String(parts[0])) else { return nil }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { return nil }
                let name = line[..<colon].lowercased()
                guard !name.isEmpty, headers[name] == nil else { return nil }
                headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            guard headers["transfer-encoding"] == nil,
                  headers["content-length"] == nil || headers["content-length"] == "0",
                  headers["host"] == "127.0.0.1" || headers["host"] == "127.0.0.1:\(port)" else { return nil }
            return (String(parts[0]), String(parts[1]), headers)
        }
        return nil
    }

    private func send(_ data: Data, to socket: Int32) -> Bool {
        return data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return true }
            var sent = 0
            while sent < bytes.count {
                if currentListener() < 0 { return false }
                let count = Darwin.send(socket, base.advanced(by: sent), bytes.count - sent, 0)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { return false }
                sent += count
            }
            return true
        }
    }

    private func header(_ status: Int, type: String = "application/octet-stream", length: Int64 = 0, to socket: Int32) -> Bool {
        let reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : "Bad Request"
        return send(Data("HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(length)\r\nContent-Type: \(type)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8), to: socket)
    }

    private func respond(to socket: Int32) -> Bool {
        guard let request = request(socket) else { _ = header(400, to: socket); return false }
        guard authenticates(request.headers["x-cutej-share-ticket"]) else { _ = header(403, to: socket); return false }
        let prefix = "/v1/share/\(batchID)"
        if request.method == "GET", request.path == "\(prefix)/manifest" {
            if header(200, type: "application/json", length: Int64(manifestData.count), to: socket) {
                _ = send(manifestData, to: socket)
            }
            return false
        }
        if request.method == "POST", request.path == "\(prefix)/complete" {
            return header(200, to: socket)
        }
        let filePrefix = "\(prefix)/file/"
        guard request.method == "GET", request.path.hasPrefix(filePrefix),
              let index = Int(request.path.dropFirst(filePrefix.count)),
              String(index) == String(request.path.dropFirst(filePrefix.count)), files.indices.contains(index) else {
            _ = header(404, to: socket)
            return false
        }
        let file = files[index]
        let source = directory.appendingPathComponent(file.name, isDirectory: false)
        let descriptor = Darwin.open(source.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { _ = header(404, to: socket); return false }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_nlink == 1, Int64(info.st_size) == file.sizeBytes,
              file.sizeBytes >= 0, file.sizeBytes <= ShareInboxLimits.standard.bytes else {
            _ = header(404, to: socket)
            return false
        }
        guard header(200, length: file.sizeBytes, to: socket) else { return false }
        var remaining = file.sizeBytes
        do {
            while remaining > 0 {
                guard let data = try input.read(upToCount: Int(min(remaining, 64 * 1024))), !data.isEmpty else { return false }
                guard send(data, to: socket) else { return false }
                remaining -= Int64(data.count)
            }
        } catch { return false }
        return false
    }

    deinit { stop() }
}
