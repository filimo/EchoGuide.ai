import AppKit
import AVFoundation
import ScreenCaptureKit
import CoreAudio

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
        config.capturesAudio = !CommandLine.arguments.contains("--diagnose-microphone-only")
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        config.captureMicrophone = !CommandLine.arguments.contains("--diagnose-application-only")
        if config.captureMicrophone, let microphone, microphone != "default" {
            emit(["type": "stage", "name": "device_lookup"])
            guard AVCaptureDevice(uniqueID: microphone) != nil else {
                fail("The selected microphone is no longer available. Refresh sources.")
            }
            config.microphoneCaptureDeviceID = microphone
        }
        emit(["type": "stage", "name": "stream_creation"])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        self.stream = stream
        if config.capturesAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        }
        if config.captureMicrophone {
            try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        }
        emit(["type": "stage", "name": "stream_start"])
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

final class MicrophoneMonitor: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "echoguide.microphone-monitor")
    let encoder = PCMEncoder()
    var lastLevel = Date.distantPast
    var streamAudio = false

    func start(identifier: String) throws {
        if streamAudio { emit(["type": "stage", "name": "device_lookup"]) }
        let device = identifier == "default" ? AVCaptureDevice.default(for: .audio) :
            AVCaptureDevice(uniqueID: identifier)
        guard let device else { fail("The selected microphone is unavailable. Refresh Mac sources.") }
        if streamAudio { emit(["type": "stage", "name": "input_creation"]) }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: queue)
        session.beginConfiguration()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            fail("Could not monitor the selected microphone.")
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        if streamAudio { emit(["type": "stage", "name": "session_start"]) }
        session.startRunning()
        guard session.isRunning else { fail("Could not start the microphone test.") }
        emit(["type": "ready"])
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard sample.isValid, let description = sample.formatDescription else { return }
        if !streamAudio {
            guard Date().timeIntervalSince(lastLevel) >= 0.1 else { return }
            lastLevel = Date()
        }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let list = AudioBufferList.allocate(maximumBuffers: Int(format.channelCount))
        defer { free(list.unsafeMutablePointer) }
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
            bufferListSizeNeededOut: nil, bufferListOut: list.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: Int(format.channelCount)),
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block)
        guard status == noErr,
              let input = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafeMutablePointer) else { return }
        input.frameLength = AVAudioFrameCount(sample.numSamples)
        do {
            let pcm = try encoder.convert(input)
            if streamAudio {
                emit(["type": "audio", "audio": pcm.base64EncodedString()])
                withExtendedLifetime(block) {}
                return
            }
            let bytes = [UInt8](pcm)
            guard bytes.count >= 2 else { return }
            var squares = 0.0
            var peak = 0.0
            for index in stride(from: 0, to: bytes.count - 1, by: 2) {
                let sample = Int16(bitPattern: UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8)
                let amplitude = abs(Double(sample) / 32768)
                squares += amplitude * amplitude
                peak = max(peak, amplitude)
            }
            emit(["type": "level", "level": sqrt(squares / Double(bytes.count / 2)), "peak": peak])
        } catch { fail("Could not measure microphone level.") }
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

func audioProperty(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope,
                   _ element: AudioObjectPropertyElement = 0) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

func inputDevice(_ identifier: String) -> AudioObjectID? {
    if identifier == "default" {
        var address = audioProperty(kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal)
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                          0, nil, &size, &device) == noErr && device != 0 ? device : nil
    }
    var address = audioProperty(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address,
                                         0, nil, &size) == noErr else { return nil }
    var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard !devices.isEmpty,
          AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                     0, nil, &size, &devices) == noErr else { return nil }
    for device in devices {
        var uidAddress = audioProperty(kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal)
        var uid: CFString? = nil
        var uidSize = UInt32(MemoryLayout<CFString?>.size)
        let status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize,
                                       UnsafeMutableRawPointer(pointer))
        }
        if status == noErr,
           uid as String? == identifier { return device }
    }
    return nil
}

func inputVolumeControls(_ device: AudioObjectID) -> [AudioObjectPropertyAddress] {
    var controls: [AudioObjectPropertyAddress] = []
    for element: UInt32 in 0...8 {
        var address = audioProperty(kAudioDevicePropertyVolumeScalar,
                                    kAudioDevicePropertyScopeInput, element)
        var writable = DarwinBoolean(false)
        if AudioObjectHasProperty(device, &address),
           AudioObjectIsPropertySettable(device, &address, &writable) == noErr,
           writable.boolValue {
            if element == 0 { return [address] }
            controls.append(address)
        }
    }
    return controls
}

func inputVolume() {
    guard CommandLine.arguments.count >= 3 else { fail("Select a microphone first.") }
    let identifier = CommandLine.arguments[2]
    guard let device = inputDevice(identifier) else {
        emit(["type": "input-volume", "available": false]); return
    }
    let controls = inputVolumeControls(device)
    guard !controls.isEmpty else { emit(["type": "input-volume", "available": false]); return }
    if CommandLine.arguments.count >= 4 {
        guard let requested = Float32(CommandLine.arguments[3]), requested >= 0,
              requested <= 1 else { fail("Invalid input volume.") }
        var value = requested
        for var address in controls {
            guard AudioObjectSetPropertyData(device, &address, 0, nil,
                                             UInt32(MemoryLayout<Float32>.size), &value) == noErr else {
                fail("Could not change this microphone's input volume.")
            }
        }
    }
    var address = controls[0]
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else {
        fail("Could not read this microphone's input volume.")
    }
    emit(["type": "input-volume", "available": true, "value": Int((value * 100).rounded())])
}

if CommandLine.arguments.contains("--self-test") { selfTest(); virtualOutputSelfTest(); exit(0) }
if CommandLine.arguments.contains("--virtual-output") { runVirtualOutput() }
if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--input-volume" {
    inputVolume(); exit(0)
}
guard #available(macOS 15.0, *) else { fail("Mac audio requires macOS 15 or later.") }
if CommandLine.arguments.count >= 2 && ["--stream-microphone", "--capture"].contains(CommandLine.arguments[1]) {
    emit(["type": "stage", "name": "process_entry"])
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var capture: Capture?
var microphoneMonitor: MicrophoneMonitor?
var capturedPID: Int32?
Task { @MainActor in
    do {
        let isCapture = CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--capture"
        if isCapture { emit(["type": "stage", "name": "main_actor"]) }
        if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--monitor-microphone" {
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard granted else { fail("Allow microphone access for EchoGuide Audio in macOS System Settings.") }
            let monitor = MicrophoneMonitor()
            microphoneMonitor = monitor
            try monitor.start(identifier: CommandLine.arguments[2])
            return
        }
        if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--stream-microphone" {
            emit(["type": "stage", "name": "main_actor"])
            emit(["type": "stage", "name": "permission"])
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard granted else { fail("Allow microphone access for EchoGuide Audio in macOS System Settings.") }
            let monitor = MicrophoneMonitor()
            monitor.streamAudio = true
            microphoneMonitor = monitor
            try monitor.start(identifier: CommandLine.arguments[2])
            return
        }
        if isCapture { emit(["type": "stage", "name": "shareable_content"]) }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        if CommandLine.arguments.contains("--list") {
            let regularPIDs = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { $0.processIdentifier })
            let applications = content.applications.filter { regularPIDs.contains($0.processID) && !$0.applicationName.isEmpty && $0.processID != getpid() }
                .sorted { $0.applicationName.localizedCaseInsensitiveCompare($1.applicationName) == .orderedAscending }
                .map { ["pid": $0.processID, "name": $0.applicationName, "bundleId": $0.bundleIdentifier] as [String: Any] }
            // Avoid initializing every HAL driver just to open source settings.
            let microphones: [[String: String]] = []
            emit(["type": "sources", "applications": applications, "microphones": microphones])
            exit(0)
        }
        guard CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--capture",
              let pid = Int32(CommandLine.arguments[2]) else { fail("Select a call application first.") }
        emit(["type": "stage", "name": "permission"])
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
