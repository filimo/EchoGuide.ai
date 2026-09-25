import AudioToolbox
import CoreAudio
import Foundation

private let virtualFrameBytes = 3_840 // 40 ms of 24 kHz, 16-bit stereo PCM.
private let maxBufferedBytes = virtualFrameBytes * 3

private final class LivePCMBuffer {
    private let lock = NSLock()
    private var bytes = Data()

    func append(_ input: Data) {
        lock.lock()
        bytes.append(input)
        if bytes.count > maxBufferedBytes {
            // Keep the newest audio so a slow output cannot build up speech delay.
            let excess = bytes.count - maxBufferedBytes
            bytes.removeFirst(excess - excess % 4)
        }
        lock.unlock()
    }

    func takeFrame() -> Data {
        lock.lock()
        let count = min(bytes.count - bytes.count % 4, virtualFrameBytes)
        let frame = Data(bytes.prefix(count))
        bytes.removeFirst(count)
        lock.unlock()
        var output = frame
        if output.count < virtualFrameBytes {
            output.append(Data(count: virtualFrameBytes - output.count))
        }
        return output
    }
}

private final class VirtualOutput {
    private var queue: AudioQueueRef?
    private var buffers: [AudioQueueBufferRef] = []
    private let pcm = LivePCMBuffer()

    private static let callback: AudioQueueOutputCallback = { context, queue, buffer in
        guard let context else { return }
        let output = Unmanaged<VirtualOutput>.fromOpaque(context).takeUnretainedValue()
        output.enqueue(buffer, on: queue)
    }

    private func enqueue(_ buffer: AudioQueueBufferRef, on queue: AudioQueueRef) {
        let bytes = pcm.takeFrame()
        bytes.withUnsafeBytes { source in
            guard let base = source.baseAddress else { return }
            memcpy(buffer.pointee.mAudioData, base, virtualFrameBytes)
        }
        buffer.pointee.mAudioDataByteSize = UInt32(virtualFrameBytes)
        if AudioQueueEnqueueBuffer(queue, buffer, 0, nil) != noErr { exit(1) }
    }

    func run() {
        emit(["type": "stage", "name": "device_lookup"])
        guard let device = outputDevice(named: "BlackHole 2ch") else {
            fail("BlackHole 2ch is unavailable as an output device.")
        }
        var format = AudioStreamBasicDescription(
            mSampleRate: 24_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
        var created: AudioQueueRef?
        let context = Unmanaged.passUnretained(self).toOpaque()
        emit(["type": "stage", "name": "queue_creation"])
        guard AudioQueueNewOutput(&format, Self.callback, context, CFRunLoopGetMain(), nil, 0, &created) == noErr,
              let created else { fail("Could not create the BlackHole audio queue.") }
        queue = created
        emit(["type": "stage", "name": "device_id"])
        var uidAddress = audioProperty(kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal)
        var uid: CFString? = nil
        var size = UInt32(MemoryLayout<CFString?>.size)
        let uidStatus = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &size,
                                       UnsafeMutableRawPointer(pointer))
        }
        guard uidStatus == noErr,
              let uid else { fail("Could not read the BlackHole device ID.") }
        var selected = uid
        emit(["type": "stage", "name": "device_selection"])
        let selectionStatus = withUnsafePointer(to: &selected) { pointer in
            AudioQueueSetProperty(created, kAudioQueueProperty_CurrentDevice,
                                  UnsafeRawPointer(pointer), UInt32(MemoryLayout<CFString?>.size))
        }
        guard selectionStatus == noErr else {
            fail("Could not route audio to BlackHole 2ch.")
        }
        emit(["type": "stage", "name": "buffer_allocation"])
        for _ in 0..<4 {
            var buffer: AudioQueueBufferRef?
            guard AudioQueueAllocateBuffer(created, UInt32(virtualFrameBytes), &buffer) == noErr,
                  let buffer else { fail("Could not allocate BlackHole audio buffers.") }
            buffers.append(buffer)
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            for buffer in buffers { enqueue(buffer, on: created) }
            emit(["type": "stage", "name": "queue_start"])
            if AudioQueueStart(created, nil) != noErr { fail("Could not start BlackHole output.") }
            emit(["type": "ready"])
            while true {
                let input = FileHandle.standardInput.readData(ofLength: 4096)
                if input.isEmpty { exit(0) }
                pcm.append(input)
            }
        }
        RunLoop.main.run()
    }
}

func virtualOutputSelfTest() {
    let buffer = LivePCMBuffer()
    for value in UInt8(0)..<UInt8(8) {
        buffer.append(Data(repeating: value, count: virtualFrameBytes))
    }
    guard buffer.takeFrame() == Data(repeating: 5, count: virtualFrameBytes),
          buffer.takeFrame() == Data(repeating: 6, count: virtualFrameBytes),
          buffer.takeFrame() == Data(repeating: 7, count: virtualFrameBytes),
          buffer.takeFrame() == Data(count: virtualFrameBytes) else {
        fail("Virtual output buffer self-test failed.")
    }
}

private func outputDevice(named name: String) -> AudioObjectID? {
    var address = audioProperty(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address,
                                         0, nil, &size) == noErr else { return nil }
    var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                     0, nil, &size, &devices) == noErr else { return nil }
    for device in devices {
        var nameAddress = audioProperty(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal)
        var value: CFString? = nil
        var valueSize = UInt32(MemoryLayout<CFString?>.size)
        let nameStatus = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &valueSize,
                                       UnsafeMutableRawPointer(pointer))
        }
        if nameStatus == noErr,
           value as String? == name { return device }
    }
    return nil
}

func runVirtualOutput() -> Never {
    emit(["type": "stage", "name": "process_entry"])
    let output = VirtualOutput()
    output.run()
    exit(0)
}
