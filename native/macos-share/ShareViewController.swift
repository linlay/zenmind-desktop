import AppKit
import Foundation
import UniformTypeIdentifiers
import OSLog

@objc(DesktopShareViewController)
final class ShareViewController: NSViewController {
    private let status = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let retry = NSButton()
    private let cancel = NSButton()
    private let worker = DispatchQueue(label: "desktop.share.receive", qos: .userInitiated)
    private var batch: ShareInboxBatch?
    private var transfer: ShareLoopbackServer?
    private var progress: Progress?
    private var finished = false
    private var generation = 0
    private var publishedID: String?
    private var providers: [NSItemProvider] = []
    private var texts: [String] = []
    private let handoffLog = Logger(subsystem: "desktop.share", category: "handoff")

    private var extensionBundle: Bundle { Bundle(for: ShareViewController.self) }
    private func text(_ key: String) -> String {
        extensionBundle.localizedString(forKey: key, value: key, table: nil)
    }
    private var productName: String {
        extensionBundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Desktop"
    }

    override func loadView() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 160))
        view = content
        preferredContentSize = content.frame.size
        let icon = NSImageView()
        icon.image = NSImage(contentsOf: extensionBundle.url(forResource: "icon", withExtension: "icns") ?? URL(fileURLWithPath: ""))
        icon.imageScaling = .scaleProportionallyUpOrDown
        let title = NSTextField(labelWithString: productName)
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.maximumNumberOfLines = 3
        spinner.style = .spinning
        spinner.controlSize = .small
        retry.title = text("retry")
        retry.bezelStyle = .rounded
        retry.target = self
        retry.action = #selector(retryReceive)
        retry.isHidden = true
        cancel.title = text("cancel")
        cancel.bezelStyle = .rounded
        cancel.target = self
        cancel.action = #selector(cancelReceive)
        cancel.keyEquivalent = "\u{1b}"
        for child in [icon, title, status, spinner, retry, cancel] {
            child.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(child)
        }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            icon.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            icon.widthAnchor.constraint(equalToConstant: 34), icon.heightAnchor.constraint(equalToConstant: 34),
            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 12),
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            status.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            status.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            spinner.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            spinner.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -23),
            cancel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            cancel.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            retry.trailingAnchor.constraint(equalTo: cancel.leadingAnchor, constant: -8),
            retry.centerYAnchor.constraint(equalTo: cancel.centerYAnchor)
        ])
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if generation == 0 { receive() }
    }

    @objc private func retryReceive() {
        if let id = publishedID { openContainingApp(id: id) }
        else { receive() }
    }

    @objc private func cancelReceive() {
        guard !finished else { return }
        finished = true
        generation += 1
        batch?.cancellation.cancel()
        progress?.cancel()
        transfer?.stop()
        transfer = nil
        if let current = batch { worker.async { current.discardStaging() } }
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    private func receive() {
        guard !finished else { return }
        generation += 1
        let currentGeneration = generation
        status.stringValue = text("receiving")
        retry.isHidden = true
        spinner.startAnimation(nil)
        providers = []
        texts = []
        for item in extensionContext?.inputItems.compactMap({ $0 as? NSExtensionItem }) ?? [] {
            let attachments = item.attachments ?? []
            providers.append(contentsOf: attachments)
            // Attributed text is a fallback, not a second copy of text attachments.
            if attachments.isEmpty, let value = item.attributedContentText?.string, !value.isEmpty {
                texts.append(value)
            }
        }
        guard providers.count + texts.count <= ShareInboxLimits.standard.files else {
            fail(ShareInboxError.tooManyFiles, generation: currentGeneration)
            return
        }
        do { batch = try ShareInboxBatch() }
        catch { fail(ShareInboxError.saveFailed, generation: currentGeneration); return }
        guard let current = batch else { return }
        let initialTexts = texts
        worker.async { [weak self] in
            do {
                for value in initialTexts {
                    try current.addData(Data(value.utf8), name: "share.txt")
                }
                DispatchQueue.main.async { self?.receiveProvider(at: 0, batch: current, generation: currentGeneration) }
            } catch {
                DispatchQueue.main.async { self?.fail(error, generation: currentGeneration) }
            }
        }
    }

    private func receiveProvider(at index: Int, batch current: ShareInboxBatch, generation currentGeneration: Int) {
        guard !finished, generation == currentGeneration else { return }
        guard index < providers.count else {
            worker.async { [weak self] in
                do {
                    let id = try current.publish()
                    DispatchQueue.main.async {
                        guard let self, !self.finished, self.generation == currentGeneration else { return }
                        self.publishedID = id
                        self.openContainingApp(id: id)
                    }
                } catch {
                    DispatchQueue.main.async { self?.fail(error, generation: currentGeneration) }
                }
            }
            return
        }
        let provider = providers[index]
        let completed: (Error?) -> Void = { [weak self] error in
            DispatchQueue.main.async {
                guard let self, !self.finished, self.generation == currentGeneration else { return }
                self.progress = nil
                if let error { self.fail(error, generation: currentGeneration) }
                else { self.receiveProvider(at: index + 1, batch: current, generation: currentGeneration) }
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                do {
                    guard error == nil, let url = Self.fileURL(item) else { throw ShareInboxError.unreadable }
                    try current.addFile(url)
                    completed(nil)
                } catch { completed(error) }
            }
            return
        }
        let identifiers = provider.registeredTypeIdentifiers
        // Keep ZIPs and images in their original representation, never unzip here.
        let fileType = identifiers.first { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .url)
        }
        if let identifier = fileType {
            progress = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                if let url, error == nil {
                    do {
                        // Provider file URLs expire when this callback returns.
                        try current.addFile(url, suggestedName: Self.filename(provider, type: identifier, fallback: url.lastPathComponent))
                        completed(nil)
                    } catch { completed(error) }
                } else {
                    // Some hosts vend an in-memory NSImage or Data instead of a file.
                    provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, itemError in
                        do {
                            guard itemError == nil else { throw ShareInboxError.unreadable }
                            if let url = Self.fileURL(item) {
                                try current.addFile(url, suggestedName: Self.filename(provider, type: identifier, fallback: url.lastPathComponent))
                            } else if let data = item as? Data {
                                try current.addData(data, name: Self.filename(provider, type: identifier, fallback: "attachment"))
                            } else if let image = item as? NSImage,
                                      let tiff = image.tiffRepresentation,
                                      let bitmap = NSBitmapImageRep(data: tiff),
                                      let png = bitmap.representation(using: .png, properties: [:]) {
                                try current.addData(png, name: "image.png")
                            } else { throw ShareInboxError.unsupported }
                            completed(nil)
                        } catch { completed(error) }
                    }
                }
            }
            return
        }
        let textType = identifiers.first { UTType($0)?.conforms(to: .text) == true }
        let urlType = identifiers.first { UTType($0)?.conforms(to: .url) == true }
        guard let identifier = textType ?? urlType else { completed(ShareInboxError.unsupported); return }
        provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, error in
            do {
                guard error == nil else { throw ShareInboxError.unreadable }
                let value: String
                if let string = item as? String { value = string }
                else if let attributed = item as? NSAttributedString { value = attributed.string }
                else if let url = item as? URL { value = url.absoluteString }
                else if let data = item as? Data, let string = String(data: data, encoding: .utf8) { value = string }
                else { throw ShareInboxError.unsupported }
                try current.addData(Data(value.utf8), name: textType == nil ? "link.txt" : "share.txt")
                completed(nil)
            } catch { completed(error) }
        }
    }

    private static func fileURL(_ item: NSSecureCoding?) -> URL? {
        if let url = item as? URL { return url.isFileURL ? url : nil }
        if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL { return url }
        return nil
    }

    private static func filename(_ provider: NSItemProvider, type: String, fallback: String) -> String {
        let proposed = provider.suggestedName?.isEmpty == false ? provider.suggestedName! : fallback
        if (proposed as NSString).pathExtension.isEmpty, let ext = UTType(type)?.preferredFilenameExtension {
            return "\(proposed).\(ext)"
        }
        return proposed
    }

    private func fail(_ error: Error, generation currentGeneration: Int) {
        guard !finished, generation == currentGeneration else { return }
        spinner.stopAnimation(nil)
        if let current = batch { worker.async { current.discardStaging() } }
        let key: String
        switch error as? ShareInboxError {
        case .tooManyFiles: key = "tooManyFiles"
        case .tooLarge: key = "tooLarge"
        case .noItems, .unsupported: key = "unsupported"
        default: key = "failed"
        }
        status.stringValue = text(key)
        retry.title = text("retry")
        retry.isHidden = false
    }

    private func openContainingApp(id: String) {
        handoffLog.info("Preparing handoff from extension bundle \(self.extensionBundle.bundleURL.path, privacy: .public)")
        guard !finished,
              let scheme = extensionBundle.object(forInfoDictionaryKey: "DesktopShareURLScheme") as? String,
              let expectedID = extensionBundle.object(forInfoDictionaryKey: "DesktopShareHostBundleIdentifier") as? String else {
            handoffLog.error("Cannot open containing app: missing extension handoff metadata")
            spinner.stopAnimation(nil)
            status.stringValue = text("openFailed")
            retry.isHidden = false
            return
        }
        var appURL = extensionBundle.bundleURL
        for _ in 0..<3 { appURL.deleteLastPathComponent() }
        // The sandbox can read its own extension bundle, but cannot reliably
        // inspect the containing app's Info.plist. Its identity is baked into our
        // signed metadata and checked again by the packaging/signing pipeline.
        guard appURL.pathExtension == "app" else {
            handoffLog.error("Cannot derive containing app from extension URL: \(appURL.path, privacy: .public)")
            spinner.stopAnimation(nil)
            status.stringValue = text("openFailed")
            retry.isHidden = false
            return
        }
        transfer?.stop()
        transfer = nil
        guard let current = batch else { return }
        let server: ShareLoopbackServer
        do { server = try ShareLoopbackServer(batch: current) }
        catch {
            handoffLog.error("Could not start the loopback sharing listener")
            spinner.stopAnimation(nil)
            status.stringValue = text("failed")
            retry.isHidden = false
            return
        }
        transfer = server
        server.start(onCompleted: { [weak self] in
            DispatchQueue.main.async {
                guard let self, !self.finished, self.transfer === server else { return }
                self.handoffLog.info("Containing app finished importing shared files")
                self.finished = true
                self.spinner.stopAnimation(nil)
                self.transfer = nil
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }, onFailure: { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.finished, self.transfer === server else { return }
                self.handoffLog.error("The loopback sharing transfer did not complete")
                self.transfer = nil
                self.spinner.stopAnimation(nil)
                self.status.stringValue = self.text("failed")
                self.retry.isHidden = false
            }
        })
        var components = URLComponents()
        components.scheme = scheme
        components.host = "share"
        components.queryItems = [
            URLQueryItem(name: "batch", value: id),
            URLQueryItem(name: "port", value: String(server.port)),
            URLQueryItem(name: "ticket", value: server.ticket)
        ]
        guard let url = components.url else { server.stop(); return }
        status.stringValue = text("opening")
        retry.isHidden = true
        spinner.startAnimation(nil)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        handoffLog.info("Opening containing app \(appURL.path, privacy: .public), bundle \(expectedID, privacy: .public), scheme \(scheme, privacy: .public)")
        // Select the containing app explicitly: dev and release share a scheme.
        NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration) { [weak self] app, error in
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                self.spinner.stopAnimation(nil)
                if error != nil || app == nil {
                    server.stop()
                    self.transfer = nil
                    if let error = error as NSError? {
                        self.handoffLog.error("Containing app open failed: \(error.domain, privacy: .public), code \(error.code)")
                        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
                            self.handoffLog.error("Underlying open error: \(underlying.domain, privacy: .public), code \(underlying.code)")
                        }
                    } else {
                        self.handoffLog.error("Containing app open failed without an application or error")
                    }
                    // A published batch survives launch failure and cancellation.
                    self.status.stringValue = self.text("openFailed")
                    self.retry.title = self.text("retry")
                    self.retry.isHidden = false
                    return
                }
                self.handoffLog.info("Containing app accepted handoff")
                // Keep the extension and listener alive until the containing
                // app has atomically imported all files and acknowledges them.
                self.status.stringValue = self.text("transferring")
                self.spinner.startAnimation(nil)
            }
        }
    }
}
