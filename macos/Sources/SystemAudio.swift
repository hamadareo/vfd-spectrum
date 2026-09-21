import Foundation
import CoreAudio
import AudioToolbox

enum SystemAudioError: Error {
    case failed(String)
}

// Captures everything the Mac is playing through a Core Audio "process tap" (macOS 14.2+): a global stereo tap
// wrapped in a private aggregate device, read from an IO proc. Needs only the "system audio recording"
// permission (NSAudioCaptureUsageDescription), not screen recording. Chunks of interleaved float32 stereo are
// delivered on the audio queue roughly every 25 ms.
final class SystemAudioTap {
    private let handlerLock = NSLock()
    private var handler: ((Data) -> Void)?
    var onChunk: ((Data) -> Void)? {
        get { handlerLock.lock(); defer { handlerLock.unlock() }; return handler }
        set { handlerLock.lock(); handler = newValue; handlerLock.unlock() }
    }
    private(set) var sampleRate: Double = 48000

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "vfd.tap", qos: .userInteractive)
    private var pending: [Float] = []
    private var flushAt = 2400

    func start() throws -> Double {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.muteBehavior = .unmuted
        description.isPrivate = true

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { throw SystemAudioError.failed("tap \(status)") }

        do {
            let outputUID = try SystemAudioTap.defaultOutputUID()
            let config: [String: Any] = [
                kAudioAggregateDeviceNameKey: "VFD Spectrum tap",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceMainSubDeviceKey: outputUID,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
                kAudioAggregateDeviceTapListKey: [[
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                ]],
            ]
            status = AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregateID)
            guard status == noErr else { throw SystemAudioError.failed("aggregate \(status)") }

            var asbd = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
                                                     mScope: kAudioObjectPropertyScopeGlobal,
                                                     mElement: kAudioObjectPropertyElementMain)
            status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
            guard status == noErr else { throw SystemAudioError.failed("format \(status)") }
            guard asbd.mFormatID == kAudioFormatLinearPCM, (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0, asbd.mBitsPerChannel == 32 else {
                throw SystemAudioError.failed("unsupported tap format")
            }
            sampleRate = asbd.mSampleRate
            flushAt = Int(sampleRate * 0.025) * 2
            let interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
            let channels = max(1, Int(asbd.mChannelsPerFrame))

            status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, input, _, _, _ in
                self?.process(input, interleaved: interleaved, channels: channels)
            }
            guard status == noErr else { throw SystemAudioError.failed("ioproc \(status)") }
            status = AudioDeviceStart(aggregateID, procID)
            guard status == noErr else { throw SystemAudioError.failed("start \(status)") }
        } catch {
            stop()
            throw error
        }
        return sampleRate
    }

    func stop() {
        onChunk = nil
        if aggregateID != kAudioObjectUnknown {
            if let p = procID {
                AudioDeviceStop(aggregateID, p)
                AudioDeviceDestroyIOProcID(aggregateID, p)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    private func process(_ list: UnsafePointer<AudioBufferList>, interleaved: Bool, channels: Int) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard abl.count > 0 else { return }
        let floatSize = MemoryLayout<Float>.size
        if interleaved {
            guard let p = abl[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            let frames = Int(abl[0].mDataByteSize) / (floatSize * channels)
            for i in 0..<frames {
                let l = p[i * channels]
                pending.append(l)
                pending.append(channels > 1 ? p[i * channels + 1] : l)
            }
        } else {
            guard let l = abl[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            let r = abl.count > 1 ? (abl[1].mData?.assumingMemoryBound(to: Float.self) ?? l) : l
            let frames = Int(abl[0].mDataByteSize) / floatSize
            for i in 0..<frames {
                pending.append(l[i])
                pending.append(r[i])
            }
        }
        if pending.count >= flushAt {
            let data = pending.withUnsafeBufferPointer { Data(buffer: $0) }
            pending.removeAll(keepingCapacity: true)
            onChunk?(data)
        }
    }

    private static func defaultOutputUID() throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr else { throw SystemAudioError.failed("output device \(status)") }
        address.mSelector = kAudioDevicePropertyDeviceUID
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        status = withUnsafeMutablePointer(to: &uid) { AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0) }
        guard status == noErr, let value = uid?.takeRetainedValue() else { throw SystemAudioError.failed("device uid \(status)") }
        return value as String
    }
}
