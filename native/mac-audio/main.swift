import AppKit
import AVFoundation
import ScreenCaptureKit

// Stdout is a private, in-memory NDJSON pipe owned by the local server.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

final class PCMEncoder {
    let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000,
                                    channels: 1, interleaved: true)!
    var converter: AVAudioConverter?
    var inputFormat: AVAudioFormat?

    func convert(_ input: AVAudioPCMBuffer) throws -> Data {
        if inputFormat != input.format {
            inputFormat = input.format
            converter = AVAudioConverter(from: input.format, to: outputFormat)
        }
        guard let converter else { throw NSError(domain: "PCM", code: 1) }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 24000 / input.format.sampleRate)) + 64
        let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity)!
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true
            state.pointee = .haveData
            return input
        }
        if let error { throw error }
        guard status != .error else { throw NSError(domain: "PCM", code: 2) }
        return Data(bytes: output.int16ChannelData![0], count: Int(output.frameLength) * 2)
    }
}

@available(macOS 15.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "echoguide.mac-audio")
    let encoders = ["microphone": PCMEncoder(), "application": PCMEncoder()]
    var stream: SCStream?

    func start(content: SCShareableContent, pid: Int32, microphone: String?) async throws {
        guard let display = content.displays.first,
              let application = content.applications.first(where: { $0.processID == pid }) else {
            fail("The selected application is no longer available. Refresh sources.")
        }
        let filter = SCContentFilter(display: display, including: [application], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        config.captureMicrophone = true
        if let microphone, microphone != "default" {
            guard AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices.contains(where: { $0.uniqueID == microphone }) else {
                fail("The selected microphone is no longer available. Refresh sources.")
            }
            config.microphoneCaptureDeviceID = microphone
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        self.stream = stream
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        try await stream.startCapture()
        queue.sync { emit(["type": "ready"]) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { fail("macOS stopped audio capture. Check permissions and restart live mode.") }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sample.isValid, type == .audio || type == .microphone,
              let description = sample.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let source = type == .microphone ? "microphone" : "application"
        let list = AudioBufferList.allocate(maximumBuffers: Int(format.channelCount))
        defer { free(list.unsafeMutablePointer) }
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
            bufferListSizeNeededOut: nil, bufferListOut: list.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: Int(format.channelCount)),
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block)
        guard status == noErr,
              let input = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafeMutablePointer) else {
            fail("Could not read captured audio.")
        }
        input.frameLength = AVAudioFrameCount(sample.numSamples)
        do {
            let pcm = try encoders[source]!.convert(input)
            if !pcm.isEmpty { emit(["type": "audio", "source": source, "audio": pcm.base64EncodedString()]) }
        } catch { fail("Could not convert captured audio to PCM.") }
        withExtendedLifetime(block) {}
    }
}

func selfTest() {
    // Exercise resampling and stereo-to-mono conversion without capture permissions.
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let encoder = PCMEncoder()
    var output = Data()
    do {
        for chunk in 0..<100 {
            let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
            input.frameLength = 480
            for index in 0..<480 {
                let value = Float(sin(Double(chunk * 480 + index) * 2 * .pi * 440 / 48000) * 0.25)
                input.floatChannelData![0][index] = value
                input.floatChannelData![1][index] = value
            }
            output.append(try encoder.convert(input))
        }
        guard output.count > 47000 && output.count <= 48000, output.contains(where: { $0 != 0 }) else {
            fail("PCM self-test failed.")
        }
        emit(["type": "self-test", "sampleRate": 24000, "channels": 1, "bytes": output.count])
    } catch { fail("PCM self-test failed.") }
}

if CommandLine.arguments.contains("--self-test") { selfTest(); exit(0) }
guard #available(macOS 15.0, *) else { fail("Mac audio requires macOS 15 or later.") }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var capture: Capture?
var capturedPID: Int32?
Task { @MainActor in
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        if CommandLine.arguments.contains("--list") {
            let regularPIDs = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { $0.processIdentifier })
            let applications = content.applications.filter { regularPIDs.contains($0.processID) && !$0.applicationName.isEmpty && $0.processID != getpid() }
                .sorted { $0.applicationName.localizedCaseInsensitiveCompare($1.applicationName) == .orderedAscending }
                .map { ["pid": $0.processID, "name": $0.applicationName, "bundleId": $0.bundleIdentifier] as [String: Any] }
            let microphones = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
            emit(["type": "sources", "applications": applications, "microphones": microphones])
            exit(0)
        }
        guard CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--capture",
              let pid = Int32(CommandLine.arguments[2]) else { fail("Select a call application first.") }
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else { fail("Allow microphone access for EchoGuide Audio in macOS System Settings.") }
        capturedPID = pid
        let instance = Capture()
        capture = instance
        try await instance.start(content: content, pid: pid,
                                 microphone: CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : nil)
    } catch {
        let nativeError = error as NSError
        fail("macOS capture failed (\(nativeError.domain), \(nativeError.code)). Allow Screen & System Audio Recording for EchoGuide Audio or the host app, then refresh sources and restart if requested.")
    }
}
// Exit if the owning server disappears, including an abrupt development-server restart.
let parent = getppid()
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    if getppid() != parent { exit(0) }
    if let pid = capturedPID, kill(pid, 0) != 0 {
        capture?.queue.async { fail("The selected call application closed. Refresh sources before restarting.") }
    }
}
app.run()
