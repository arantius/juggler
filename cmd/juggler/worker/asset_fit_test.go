//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// splitImage is a w×h opaque image whose left half is red and right half
// blue, so a test can tell which way it was turned.
func splitImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.RGBA{R: 220, G: 30, B: 30, A: 255}
			if x >= w/2 {
				c = color.RGBA{R: 30, G: 30, B: 220, A: 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// withEXIFOrientation inserts an APP1 segment carrying the given EXIF
// orientation tag straight after a JPEG's SOI marker, as a phone camera writes
// it.
func withEXIFOrientation(jpg []byte, orientation uint16) []byte {
	var tiff bytes.Buffer
	tiff.WriteString("MM")
	_ = binary.Write(&tiff, binary.BigEndian, uint16(42))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(8)) // IFD0 offset
	_ = binary.Write(&tiff, binary.BigEndian, uint16(1)) // one entry
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(3)) // SHORT
	_ = binary.Write(&tiff, binary.BigEndian, uint32(1))
	_ = binary.Write(&tiff, binary.BigEndian, orientation)
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0)) // value padding
	_ = binary.Write(&tiff, binary.BigEndian, uint32(0)) // no next IFD
	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)

	out := append([]byte{}, jpg[:2]...)
	out = append(out, 0xFF, 0xE1)
	out = binary.BigEndian.AppendUint16(out, uint16(len(payload)+2))
	out = append(out, payload...)
	return append(out, jpg[2:]...)
}

// decodeFitted decodes a fitted image, failing the test unless its bytes,
// mime and reported dimensions all agree.
func decodeFitted(t *testing.T, fitted FittedImage) image.Image {
	t.Helper()
	img, format, err := image.Decode(bytes.NewReader(fitted.Data))
	if err != nil {
		t.Fatalf("fitted bytes do not decode: %v", err)
	}
	if want := "image/" + format; fitted.Mime != want {
		t.Errorf("Mime = %q, but the bytes are %s", fitted.Mime, want)
	}
	if b := img.Bounds(); b.Dx() != fitted.Width || b.Dy() != fitted.Height {
		t.Errorf("reported %dx%d, but the bytes are %dx%d", fitted.Width, fitted.Height, b.Dx(), b.Dy())
	}
	return img
}

func isReddish(c color.Color) bool {
	r, _, b, _ := c.RGBA()
	return r > 2*b
}

func isBluish(c color.Color) bool {
	r, _, b, _ := c.RGBA()
	return b > 2*r
}

// A phone photo is several times larger than a model looks at, and is
// resent with every request of the conversation: it is scaled so its long
// edge is ModelImageMaxEdge, keeping its aspect ratio.
func TestFitImageForModelScalesLongEdge(t *testing.T) {
	src := encodeJPEG(t, splitImage(4032, 3024))
	fitted, ok := FitImageForModel(src, "image/jpeg")
	if !ok {
		t.Fatal("a 4032x3024 photo was not fitted")
	}
	decodeFitted(t, fitted)
	if fitted.Width != 1568 || fitted.Height != 1176 {
		t.Errorf("fitted to %dx%d, want 1568x1176", fitted.Width, fitted.Height)
	}
	if len(fitted.Data) >= len(src) {
		t.Errorf("fitted image is %d bytes, not smaller than the %d-byte original", len(fitted.Data), len(src))
	}
}

// An image that already fits goes out as uploaded, byte for byte.
func TestFitImageForModelLeavesFittingImageAlone(t *testing.T) {
	src := encodeJPEG(t, splitImage(1568, 900))
	fitted, ok := FitImageForModel(src, "image/jpeg")
	if ok {
		t.Fatal("an image that already fits was re-encoded")
	}
	if !bytes.Equal(fitted.Data, src) || fitted.Mime != "image/jpeg" {
		t.Error("an image that already fits did not come back unchanged")
	}
}

// Re-encoding drops EXIF, so a phone photo stored sideways with an
// orientation tag would reach the model sideways. The tag is applied to the
// pixels: orientation 6 (rotate 90° clockwise) turns a landscape frame whose
// left half is red into a portrait one whose top half is red.
func TestFitImageForModelAppliesEXIFOrientation(t *testing.T) {
	src := withEXIFOrientation(encodeJPEG(t, splitImage(4000, 2000)), 6)
	fitted, ok := FitImageForModel(src, "image/jpeg")
	if !ok {
		t.Fatal("a 4000x2000 photo was not fitted")
	}
	img := decodeFitted(t, fitted)
	if fitted.Width != 784 || fitted.Height != 1568 {
		t.Fatalf("fitted to %dx%d, want the upright 784x1568", fitted.Width, fitted.Height)
	}
	if top := img.At(392, 100); !isReddish(top) {
		t.Errorf("top centre is %v, want the red half rotated to the top", top)
	}
	if bottom := img.At(392, 1468); !isBluish(bottom) {
		t.Errorf("bottom centre is %v, want the blue half rotated to the bottom", bottom)
	}
}

// Transparency survives: an image with alpha stays a PNG.
func TestFitImageForModelKeepsAlpha(t *testing.T) {
	img := splitImage(3000, 1000)
	for y := 0; y < 1000; y++ {
		for x := 0; x < 100; x++ {
			img.SetRGBA(x, y, color.RGBA{})
		}
	}
	fitted, ok := FitImageForModel(encodePNG(t, img), "image/png")
	if !ok {
		t.Fatal("a 3000x1000 PNG was not fitted")
	}
	decodeFitted(t, fitted)
	if fitted.Mime != "image/png" {
		t.Errorf("Mime = %q, want image/png to keep the transparency", fitted.Mime)
	}
	if fitted.Width != 1568 || fitted.Height != 523 {
		t.Errorf("fitted to %dx%d, want 1568x523", fitted.Width, fitted.Height)
	}
}

// WebP decodes too, and goes out in a format the encoder can write.
func TestFitImageForModelFitsWebP(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "fit-2000x1000.webp"))
	if err != nil {
		t.Fatal(err)
	}
	fitted, ok := FitImageForModel(src, "image/webp")
	if !ok {
		t.Fatal("a 2000x1000 WebP was not fitted")
	}
	decodeFitted(t, fitted)
	if fitted.Width != 1568 || fitted.Height != 784 {
		t.Errorf("fitted to %dx%d, want 1568x784", fitted.Width, fitted.Height)
	}
}

// Saving a WebP records its dimensions, which the token estimate prices it by.
func TestAssetStoreSaveReadsWebPDimensions(t *testing.T) {
	store, _ := testAssetStore(t)
	src, err := os.ReadFile(filepath.Join("testdata", "fit-2000x1000.webp"))
	if err != nil {
		t.Fatal(err)
	}
	ref, err := store.Save("conv-webp", src, "image/webp")
	if err != nil {
		t.Fatal(err)
	}
	if ref.Width != 2000 || ref.Height != 1000 {
		t.Errorf("WebP saved as %dx%d, want 2000x1000", ref.Width, ref.Height)
	}
}

// ResolveForModel fills each asset-backed part with what the model is sent:
// the fitted bytes, with the mime and dimensions those bytes actually have, so
// admission prices the image the provider receives rather than the upload.
// An image that already fits keeps its original bytes.
func TestResolveForModelSendsFittedImages(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-fit"
	big, err := store.Save(convID, encodePNG(t, splitImage(3136, 2000)), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	smallBytes := encodePNG(t, splitImage(400, 300))
	small, err := store.Save(convID, smallBytes, "image/png")
	if err != nil {
		t.Fatal(err)
	}

	msgs := []provider.Message{{Type: "user", Parts: []provider.MediaPart{
		{Type: "image", Mime: big.Mime, AssetID: big.ID, Width: big.Width, Height: big.Height},
		{Type: "image", Mime: small.Mime, AssetID: small.ID, Width: small.Width, Height: small.Height},
	}}}
	store.ResolveForModel(convID, msgs)

	fittedPart := msgs[0].Parts[0]
	decodeFitted(t, FittedImage{Data: fittedPart.Data, Mime: fittedPart.Mime, Width: fittedPart.Width, Height: fittedPart.Height})
	if fittedPart.Width != 1568 || fittedPart.Height != 1000 {
		t.Errorf("large part sent at %dx%d, want 1568x1000", fittedPart.Width, fittedPart.Height)
	}
	if smallPart := msgs[0].Parts[1]; !bytes.Equal(smallPart.Data, smallBytes) || smallPart.Width != 400 || smallPart.Height != 300 {
		t.Errorf("small part changed: %d bytes at %dx%d", len(smallPart.Data), smallPart.Width, smallPart.Height)
	}
}

// Fitting is done once per image, not once per request: the conversation
// resends every image on every turn, and decoding and scaling ten photos each
// time would hold up every turn by seconds. The second resolve is served from
// the cache, which the asset's removal from disk makes observable.
func TestResolveForModelCachesFittedImages(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-fit-cache"
	big, err := store.Save(convID, encodeJPEG(t, splitImage(3200, 1600)), "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	part := provider.MediaPart{Type: "image", Mime: big.Mime, AssetID: big.ID, Width: big.Width, Height: big.Height}

	first := []provider.Message{{Type: "user", Parts: []provider.MediaPart{part}}}
	store.ResolveForModel(convID, first)
	if len(first[0].Parts[0].Data) == 0 {
		t.Fatal("first resolve loaded nothing")
	}
	if err := store.Delete(convID, big.ID); err != nil {
		t.Fatal(err)
	}

	second := []provider.Message{{Type: "user", Parts: []provider.MediaPart{part}}}
	store.ResolveForModel(convID, second)
	if !bytes.Equal(second[0].Parts[0].Data, first[0].Parts[0].Data) {
		t.Error("second resolve did not come from the cache of the first")
	}
}
