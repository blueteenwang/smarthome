/**
 Local face feature helper for NOVA.

 Uses Apple's Vision framework only. It detects the largest face, crops it,
 creates an image feature print, and securely archives that feature. Original
 enrollment images are never written by this process.
 */
import Foundation
import Vision
import ImageIO
import CoreGraphics

enum FaceError: Error, CustomStringConvertible {
    case usage, image, noFace, archive
    var description: String {
        switch self {
        case .usage: return "usage: face-vision extract <image> <feature> | compare <feature-a> <feature-b>"
        case .image: return "无法读取图片"
        case .noFace: return "图片中没有检测到清晰人脸"
        case .archive: return "无法读写人脸特征"
        }
    }
}

func loadImage(_ path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw FaceError.image }
    return image
}

func largestFace(in image: CGImage) throws -> CGImage {
    let request = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    guard let face = request.results?.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) else { throw FaceError.noFace }
    let box = face.boundingBox
    let padding = 0.18
    let x = max(0, box.minX - box.width * padding)
    let y = max(0, box.minY - box.height * padding)
    let w = min(1 - x, box.width * (1 + padding * 2))
    let h = min(1 - y, box.height * (1 + padding * 2))
    let rect = CGRect(x: x * CGFloat(image.width), y: (1 - y - h) * CGFloat(image.height), width: w * CGFloat(image.width), height: h * CGFloat(image.height)).integral
    guard let crop = image.cropping(to: rect) else { throw FaceError.image }
    return crop
}

func feature(for image: CGImage) throws -> VNFeaturePrintObservation {
    let request = VNGenerateImageFeaturePrintRequest()
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    guard let result = request.results?.first as? VNFeaturePrintObservation else { throw FaceError.archive }
    return result
}

func save(_ observation: VNFeaturePrintObservation, to path: String) throws {
    let data = try NSKeyedArchiver.archivedData(withRootObject: observation, requiringSecureCoding: true)
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func read(_ path: String) throws -> VNFeaturePrintObservation {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let value = try NSKeyedUnarchiver.unarchivedObject(ofClass: VNFeaturePrintObservation.self, from: data) else { throw FaceError.archive }
    return value
}

do {
    let args = CommandLine.arguments
    guard args.count == 4 else { throw FaceError.usage }
    if args[1] == "extract" {
        let image = try largestFace(in: loadImage(args[2]))
        try save(feature(for: image), to: args[3])
        print("{\"ok\":true}")
    } else if args[1] == "compare" {
        var distance: Float = 0
        try read(args[2]).computeDistance(&distance, to: read(args[3]))
        print("{\"ok\":true,\"distance\":\(distance)}")
    } else { throw FaceError.usage }
} catch {
    let message = String(describing: error).replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    FileHandle.standardError.write("{\"ok\":false,\"error\":\"\(message)\"}\n".data(using: .utf8)!)
    exit(1)
}
