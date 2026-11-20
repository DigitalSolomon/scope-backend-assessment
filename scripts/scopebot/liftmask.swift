// Writes a grayscale foreground mask (white = subject) for every PNG in a
// directory, using Vision's on-device subject lifting.
// Usage: liftmask <frames_dir> <masks_dir>
import AppKit
import CoreImage
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: liftmask <frames_dir> <masks_dir>\n".data(using: .utf8)!)
    exit(2)
}
let inDir = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let ctx = CIContext()
let files = try FileManager.default.contentsOfDirectory(atPath: inDir.path)
    .filter { $0.hasSuffix(".png") }.sorted()

var failures = 0
for name in files {
    let url = inDir.appendingPathComponent(name)
    guard let src = CIImage(contentsOf: url) else { failures += 1; continue }
    let handler = VNImageRequestHandler(ciImage: src)
    let request = VNGenerateForegroundInstanceMaskRequest()
    do {
        try handler.perform([request])
        guard let obs = request.results?.first else {
            print("\(name): no subject"); failures += 1; continue
        }
        // Mask covering all detected instances, at the source resolution.
        let buf = try obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler)
        let mask = CIImage(cvPixelBuffer: buf)
        let out = outDir.appendingPathComponent(name)
        try ctx.writePNGRepresentation(
            of: mask, to: out, format: .L8,
            colorSpace: CGColorSpace(name: CGColorSpace.linearGray)!)
    } catch {
        print("\(name): \(error)"); failures += 1
    }
}
print("masks: \(files.count - failures)/\(files.count)")
