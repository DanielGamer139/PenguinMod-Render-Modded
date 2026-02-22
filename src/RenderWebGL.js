import blurHorizontalFrag from './shaders/blur-horizontal.frag';
import blurVerticalFrag from './shaders/blur-vertical.frag';

const EventEmitter = require('events');
const hull = require('hull.js');
const twgl = require('twgl.js');

const SVGRenderer = require('scratch-svg-renderer');
const Skin = require('./Skin');
const BitmapSkin = require('./BitmapSkin');
const Drawable = require('./Drawable');
const Rectangle = require('./Rectangle');
const PenSkin = require('./PenSkin');
const RenderConstants = require('./RenderConstants');
const ShaderManager = require('./ShaderManager');
const SVGSkin = require('./SVGSkin');
const TextBubbleSkin = require('./TextBubbleSkin');
const TextCostumeSkin = require('./TextCostumeSkin');
const EffectTransform = require('./EffectTransform');
const CanvasMeasurementProvider = require('./util/canvas-measurement-provider');
const log = require('./util/log');

const __isTouchingDrawablesPoint = twgl.v3.create();
const __candidatesBounds = new Rectangle();
const __fenceBounds = new Rectangle();
const __touchingColor = new Uint8ClampedArray(4);
const __blendColor = new Uint8ClampedArray(4);

// More pixels than this and we give up to the GPU and take the cost of readPixels
// Width * Height * Number of drawables at location
const __cpuTouchingColorPixelCount = 4e4;

/**
 * @callback RenderWebGL#idFilterFunc
 * @param {int} drawableID The ID to filter.
 * @return {bool} True if the ID passes the filter, otherwise false.
 */

/**
 * Maximum touch size for a picking check.
 * @todo Figure out a reasonable max size. Maybe this should be configurable?
 * @type {Array<int>}
 * @memberof RenderWebGL
 */
const MAX_TOUCH_SIZE = [3, 3];

/**
 * Passed to the uniforms for mask in touching color
 */
const MASK_TOUCHING_COLOR_TOLERANCE = 2;

/**
 * Maximum number of pixels in either dimension of "extracted drawable" data
 * @type {int}
 */
const MAX_EXTRACTED_DRAWABLE_DIMENSION = 2048;

/**
 * Determines if the mask color is "close enough" (only test the 6 top bits for
 * each color).    These bit masks are what scratch 2 used to use, so we do the same.
 * @param {Uint8Array} a A color3b or color4b value.
 * @param {Uint8Array} b A color3b or color4b value.
 * @returns {boolean} If the colors match within the parameters.
 */
const maskMatches = (a, b) =>
    // has some non-alpha component to test against
    a[3] > 0 &&
    (a[0] & 0b11111100) === (b[0] & 0b11111100) &&
    (a[1] & 0b11111100) === (b[1] & 0b11111100) &&
    (a[2] & 0b11111100) === (b[2] & 0b11111100);

/**
 * Determines if the given color is "close enough" (only test the 5 top bits for
 * red and green, 4 bits for blue).    These bit masks are what scratch 2 used to use,
 * so we do the same.
 * @param {Uint8Array} a A color3b or color4b value.
 * @param {Uint8Array} b A color3b or color4b value / or a larger array when used with offsets
 * @param {number} offset An offset into the `b` array, which lets you use a larger array to test
 *                                    multiple values at the same time.
 * @returns {boolean} If the colors match within the parameters.
 */
const colorMatches = (a, b, offset) =>
    (a[0] & 0b11111000) === (b[offset + 0] & 0b11111000) &&
    (a[1] & 0b11111000) === (b[offset + 1] & 0b11111000) &&
    (a[2] & 0b11110000) === (b[offset + 2] & 0b11110000);

/**
 * Sprite Fencing - The number of pixels a sprite is required to leave remaining
 * onscreen around the edge of the staging area.
 * @type {number}
 */
const FENCE_WIDTH = 15;

// Loading text wrapper takes a while because of some of its dependencies, so only do so when needed.
let _TextWrapper;
const lazilyLoadTextWrapper = () => {
    if (!_TextWrapper) {
        // eslint-disable-next-line global-require
        _TextWrapper = require('./util/text-wrapper');
    }
    return _TextWrapper;
};

let _stylesheet;
const loadStyles = () => {
    if (!_stylesheet) {
        _stylesheet = document.createElement('style');
        // eslint-disable-next-line global-require
        _stylesheet.textContent = require('!raw-loader!./renderer.css');
        _stylesheet.className = 'scratch-render-styles';
        document.head.appendChild(_stylesheet);
    }
};

class RenderWebGL extends EventEmitter {
    /**
     * Check if this environment appears to support this renderer before attempting to create an instance.
     * Catching an exception from the constructor is also a valid way to test for (lack of) support.
     * @param {canvas} [optCanvas] - An optional canvas to use for the test. Otherwise a temporary canvas will be used.
     * @returns {boolean} - True if this environment appears to support this renderer, false otherwise.
     */
    static isSupported (optCanvas) {
        try {
            optCanvas = optCanvas || document.createElement('canvas');
            const options = {
                alpha: true,
                stencil: true,
                antialias: false,
                xrCompatible: true
            };
            return !!(
                optCanvas.getContext('webgl2', options) ||
                optCanvas.getContext('experimental-webgl', options) ||
                optCanvas.getContext('webgl', options)
            );
        } catch (e) {
            return false;
        }
    }

    /**
     * Ask TWGL to create a rendering context with the attributes used by this renderer.
     * @param {canvas} canvas - attach the context to this canvas.
     * @returns {WebGLRenderingContext} - a TWGL rendering context (backed by either WebGL 1.0 or 2.0).
     * @private
     */
    static _getContext (canvas) {
        const contextAttribs = {
            alpha: true,
            stencil: true,
            antialias: false,
            xrCompatible: true,
            powerPreference: RenderWebGL.powerPreference
        };
        // getWebGLContext = try WebGL 1.0 only
        // getContext = try WebGL 2.0 and if that doesn't work, try WebGL 1.0
        // getWebGLContext || getContext = try WebGL 1.0 and if that doesn't work, try WebGL 2.0
        return (
            twgl.getContext(canvas, contextAttribs) ||
            twgl.getWebGLContext(canvas, contextAttribs)
        );
    }

    /**
     * Create a renderer for drawing Scratch sprites to a canvas using WebGL.
     * Coordinates will default to Scratch 2.0 values if unspecified.
     * The stage's "native" size will be calculated from the these coordinates.
     * For example, the defaults result in a native size of 480x360.
     * Queries such as "touching color?" will always execute at the native size.
     * @see RenderWebGL#setStageSize
     * @see RenderWebGL#resize
     * @param {canvas} canvas The canvas to draw onto.
     * @param {int} [xLeft=-240] The x-coordinate of the left edge.
     * @param {int} [xRight=240] The x-coordinate of the right edge.
     * @param {int} [yBottom=-180] The y-coordinate of the bottom edge.
     * @param {int} [yTop=180] The y-coordinate of the top edge.
     * @constructor
     * @listens RenderWebGL#event:NativeSizeChanged
     */
    constructor (canvas, xLeft, xRight, yBottom, yTop) {
        super();

        /** @type {WebGLRenderingContext} */
        const gl = (this._gl = RenderWebGL._getContext(canvas));
        if (!gl) {
            throw new Error(
                'Could not get WebGL context: this browser or environment may not support WebGL.'
            );
        }

        /** @type {RenderWebGL.UseGpuModes} */
        this._useGpuMode = RenderWebGL.UseGpuModes.Automatic;

        /** @type {Drawable[]} */
        this._allDrawables = [];

        /** @type {Skin[]} */
        this._allSkins = [];

        /** @type {Array<int>} */
        this._drawList = [];

        // A list of layer group names in the order they should appear
        // from furthest back to furthest in front.
        /** @type {Array<String>} */
        this._groupOrdering = [];

        /**
         * @typedef LayerGroup
         * @property {int} groupIndex The relative position of this layer group in the group ordering
         * @property {int} drawListOffset The absolute position of this layer group in the draw list
         * This number gets updated as drawables get added to or deleted from the draw list.
         */

        // Map of group name to layer group
        /** @type {Object.<string, LayerGroup>} */
        this._layerGroups = {};

        /** @type {int} */
        this._nextDrawableId = RenderConstants.ID_NONE + 1;

        /** @type {int} */
        this._nextSkinId = RenderConstants.ID_NONE + 1;

        /** @type {module:twgl/m4.Mat4} */
        this._projection = twgl.m4.identity();

        /** @type {ShaderManager} */
        this._shaderManager = new ShaderManager(gl);

        // blur shader programs
        this._blurHorizontalProgram = twgl.createProgramInfo(gl, [
            require('raw-loader!./shaders/sprite.vert.glsl'),
            blurHorizontalFrag
        ]);
        this._blurVerticalProgram = twgl.createProgramInfo(gl, [
            require('raw-loader!./shaders/sprite.vert.glsl'),
            blurVerticalFrag
        ]);

        /** @type {any} */
        this._regionId = null;

        /** @type {function} */
        this._exitRegion = null;

        /** @type {object} */
        this._backgroundDrawRegionId = {
            enter: () => this._enterDrawBackground(),
            exit: () => this._exitDrawBackground()
        };

        /** @type {Array.<snapshotCallback>} */
        this._snapshotCallbacks = [];

        /** @type {Array<number>} */
        // Don't set this directly-- use setBackgroundColor so it stays in sync with _backgroundColor3b
        this._backgroundColor4f = [0, 0, 0, 1];

        /** @type {Uint8ClampedArray} */
        // Don't set this directly-- use setBackgroundColor so it stays in sync with _backgroundColor4f
        this._backgroundColor3b = new Uint8ClampedArray(3);

        // tw: track id of pen skin
        this._penSkinId = null;

        // pm: extra rendering settings
        this.customRenderConfig = {
            textCostumeResolution: {
                capped: false,
                fixed: false,
                value: 1
            }
        };

        this.useHighQualityRender = true;

        this.offscreenTouching = false;

        this.dirty = true;

        /**
         * Element that contains all overlays.
         * @type {HTMLElement}
         */
        this.overlayContainer = document.createElement('div');
        this.overlayContainer.className = 'scratch-render-overlays';

        /**
         * @type {Array<{container: HTMLElement; userElement: HTMLElement; mode: string;}>}
         */
        this._overlays = [];

        loadStyles();

        this._createGeometry();

        this.on(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);

        this.setBackgroundColor(1, 1, 1);
        this.setStageSize(
            xLeft || -240,
            xRight || 240,
            yBottom || -180,
            yTop || 180
        );
        this.resize(this._nativeSize[0], this._nativeSize[1]);

        gl.disable(gl.DEPTH_TEST);
        /** @todo disable when no partial transparency? */
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        /**
         * Whether or not the renderer should be drawing to an XR layer.
         * Used for the Virtual Reality extension.
         */
        this.xrEnabled = false;

        /**
         * Whether or not the renderer should be drawing the image split for VR screens.
         * Used for the Virtual Reality extension.
         */
        this.xrSplitting = false;

        /**
         * An offset where the XR splitting will shift closer to the center.
         * Used for the Virtual Reality extension.
         */
        this.xrSplitOffset = 0;

        /**
         * The layer that should be drawn to.
         * Used for the Virtual Reality extension.
         */
        this.xrLayer = null;

        /**
         * set to true by default as this is still expieremental
         */
        this.renderOffscreen = true;

        /**
         * Whether projects should be able to access the contents of private skins such as webcams.
         * If set to false, routines such as isTouchingColor will ignore private skins.
         * Private skins will still be rendered on the canvas regardless of this setting.
         * This is set to true by default for compatibility with vanilla Scratch.
         * @type {boolean}
         */
        this.allowPrivateSkinAccess = true;

        /**
         * Suggested maximum texture size in texels. This is not a hard limit.
         * Defualt value is same as Scratch's SVGSkin max.
         * @type {number}
         */
        this.maxTextureDimension = 2048;

        /**
         * Custom fonts, used by SVGs. Maps font families to their @font-face statement.
         * Do not modify directly -- use {@link setCustomFonts}.
         * @type {Record<string, string>}
         */
        this.customFonts = {};

        /**
         * <style> element used for custom fonts.
         * @type {HTMLStyleElement|null}
         */
        this._customFontStyles = null;

        /**
         * Export internals for third-party extensions.
         */
        this.exports = {
            twgl,
            SVGRenderer,
            Drawable,
            Skin,
            BitmapSkin,
            TextBubbleSkin,
            PenSkin,
            SVGSkin,
            CanvasMeasurementProvider,
            Rectangle
        };
    }

    setRenderOffscreen (bool) {
        this.renderOffscreen = bool;
        this.dirty = true;
        this.draw();
    }

    // tw: implement high quality pen option
    setUseHighQualityRender (enabled) {
        this.dirty = true;
        this.useHighQualityRender = enabled;
        this.emit(RenderConstants.Events.UseHighQualityRenderChanged, enabled);
        this._updateRenderQuality();
    }

    _updateRenderQuality () {
        if (this._penSkinId !== null) {
            const skin = this._allSkins[this._penSkinId];
            if (skin) {
                if (this.useHighQualityRender) {
                    skin.setRenderQuality(this.canvas.width / this._nativeSize[0]);
                } else {
                    skin.setRenderQuality(1);
                }
            }
        }
        for (const drawable of this._allDrawables) {
            if (drawable) {
                drawable.setHighQuality(this.useHighQualityRender);
            }
        }
    }

    /**
     * Configure whether the renderer should let projects access private skins.
     * @param {boolean} allowPrivateSkinAccess Whether projects can access private skins or not.
     */
    setPrivateSkinAccess (allowPrivateSkinAccess) {
        this.allowPrivateSkinAccess = allowPrivateSkinAccess;
        this.emit(
            RenderConstants.Events.AllowPrivateSkinAccessChanged,
            allowPrivateSkinAccess
        );
    }

    /**
     * Modify the suggested maximum texture dimension. This should be set before any skins are created.
     * @param {number} newMax The new maximum in texels
     */
    setMaxTextureDimension (newMax) {
        const hardwareLimit = this._gl.getParameter(this._gl.MAX_TEXTURE_SIZE);
        this.maxTextureDimension = Math.min(newMax, hardwareLimit);
    }

    /**
     * @returns {WebGLRenderingContext} the WebGL rendering context associated with this renderer.
     */
    get gl () {
        return this._gl;
    }

    /**
     * @returns {HTMLCanvasElement} the canvas of the WebGL rendering context associated with this renderer.
     */
    get canvas () {
        return this._gl && this._gl.canvas;
    }

    /**
     * Set the physical size of the stage in device-independent pixels.
     * This will be multiplied by the device's pixel ratio on high-DPI displays.
     * @param {int} pixelsWide The desired width in device-independent pixels.
     * @param {int} pixelsTall The desired height in device-independent pixels.
     */
    resize (pixelsWide, pixelsTall) {
        const {canvas} = this._gl;
        const pixelRatio = window.devicePixelRatio || 1;
        const newWidth = pixelsWide * pixelRatio;
        const newHeight = pixelsTall * pixelRatio;

        // Certain operations, such as moving the color picker, call `resize` once per frame, even though the canvas
        // size doesn't change. To avoid unnecessary canvas updates, check that we *really* need to resize the canvas.
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;

            this._updateRenderQuality();
            this._updateOverlays();

            // Resizing the canvas causes it to be cleared, so redraw it.
            this.dirty = true;
            this.draw();
        }
    }

    /**
     * Set the background color for the stage. The stage will be cleared with this
     * color each frame.
     * @param {number} red The red component for the background.
     * @param {number} green The green component for the background.
     * @param {number} blue The blue component for the background.
     * @param {number} alpha The alpha component for the background.
     */
    setBackgroundColor (red, green, blue, alpha = 1) {
        this.dirty = true;

        // WebGL will want the color to be pre-multiplied.

        this._backgroundColor4f[0] = red * alpha;
        this._backgroundColor4f[1] = green * alpha;
        this._backgroundColor4f[2] = blue * alpha;
        this._backgroundColor4f[3] = alpha;

        this._backgroundColor3b[0] = red * alpha * 255;
        this._backgroundColor3b[1] = green * alpha * 255;
        this._backgroundColor3b[2] = blue * alpha * 255;
    }

    /**
     * Tell the renderer to draw various debug information to the provided canvas
     * during certain operations.
     * @param {canvas} canvas The canvas to use for debug output.
     */
    setDebugCanvas (canvas) {
        this._debugCanvas = canvas;
    }

    /**
     * Control the use of the GPU or CPU paths in `isTouchingColor`.
     * @param {RenderWebGL.UseGpuModes} useGpuMode - automatically decide, force CPU, or force GPU.
     */
    setUseGpuMode (useGpuMode) {
        this._useGpuMode = useGpuMode;
    }

    /**
     * Set logical size of the stage in Scratch units.
     * @param {int} xLeft The left edge's x-coordinate. Scratch 2 uses -240.
     * @param {int} xRight The right edge's x-coordinate. Scratch 2 uses 240.
     * @param {int} yBottom The bottom edge's y-coordinate. Scratch 2 uses -180.
     * @param {int} yTop The top edge's y-coordinate. Scratch 2 uses 180.
     */
    setStageSize (xLeft, xRight, yBottom, yTop) {
        this._xLeft = xLeft;
        this._xRight = xRight;
        this._yBottom = yBottom;
        this._yTop = yTop;

        // swap yBottom & yTop to fit Scratch convention of +y=up
        this._projection = twgl.m4.ortho(xLeft, xRight, yBottom, yTop, -1, 1);

        this._setNativeSize(Math.abs(xRight - xLeft), Math.abs(yBottom - yTop));
    }

    /**
     * @return {Array<int>} the "native" size of the stage, which is used for pen, query renders, etc.
     */
    getNativeSize () {
        return [this._nativeSize[0], this._nativeSize[1]];
    }

    /**
     * Set the "native" size of the stage, which is used for pen, query renders, etc.
     * @param {int} width - the new width to set.
     * @param {int} height - the new height to set.
     * @private
     * @fires RenderWebGL#event:NativeSizeChanged
     */
    _setNativeSize (width, height) {
        this._nativeSize = [width, height];
        this._updateOverlays();
        this.emit(RenderConstants.Events.NativeSizeChanged, {
            newSize: this._nativeSize
        });
    }

    /**
     * @param {HTMLElement} element HTML element
     * @param {string} mode Resize mode
     * @returns {*} Internal overlay object
     */
    addOverlay (element, mode = 'scale') {
        const container = document.createElement('div');
        container.appendChild(element);
        this.overlayContainer.appendChild(container);
        const overlay = {
            container,
            userElement: element,
            mode
        };
        this._overlays.push(overlay);
        this._updateOverlays();
        return overlay;
    }

    /**
     * @param {HTMLElement} element HTML element
     */
    removeOverlay (element) {
        const overlayIndex = this._overlays.findIndex(
            i => i.userElement === element
        );
        if (overlayIndex !== -1) {
            this._overlays[overlayIndex].container.remove();
            this._overlays.splice(overlayIndex, 1);
        }
    }

    _updateOverlays () {
        const [nativeWidth, nativeHeight] = this._nativeSize;
        const dpiIndependentWidth = this.canvas.width / window.devicePixelRatio;
        const dpiIndependentHeight = this.canvas.height / window.devicePixelRatio;

        this.overlayContainer.style.width = `${dpiIndependentWidth}px`;
        this.overlayContainer.style.height = `${dpiIndependentHeight}px`;

        for (const overlay of this._overlays) {
            const container = overlay.container;
            if (overlay.mode === 'scale' || overlay.mode === 'scale-centered') {
                const xScale = dpiIndependentWidth / nativeWidth;
                const yScale = dpiIndependentHeight / nativeHeight;
                container.style.width = `${nativeWidth}px`;
                container.style.height = `${nativeHeight}px`;

                const scale = `scale(${xScale}, ${yScale})`;
                container.style.transformOrigin = 'top left';
                if (overlay.mode === 'scale') {
                    container.style.transform = scale;
                } else {
                    const shiftToCenter = `translate(${nativeWidth / 2}px, ${nativeHeight / 2}px)`;
                    container.style.transform = `${scale} ${shiftToCenter}`;
                }
            } else {
                container.style.transform = '';
                container.style.width = '100%';
                container.style.height = '100%';
            }
        }
    }

    /**
     * Create a new bitmap skin from a snapshot of the provided bitmap data.
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - new contents for this skin.
     * @param {!int} [costumeResolution=1] - The resolution to use for this bitmap.
     * @param {?Array<number>} [rotationCenter] Optional: rotation center of the skin. If not supplied, the center of
     * the skin will be used.
     * @returns {!int} the ID for the new skin.
     */
    createBitmapSkin (bitmapData, costumeResolution, rotationCenter) {
        const skinId = this._nextSkinId++;
        const newSkin = new BitmapSkin(skinId, this);
        newSkin.setBitmap(bitmapData, costumeResolution, rotationCenter);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Create a new SVG skin.
     * @param {!string} svgData - new SVG to use.
     * @param {?Array<number>} rotationCenter Optional: rotation center of the skin. If not supplied, the center of the
     * skin will be used
     * @returns {!int} the ID for the new skin.
     */
    createSVGSkin (svgData, rotationCenter) {
        const skinId = this._nextSkinId++;
        const newSkin = new SVGSkin(skinId, this);
        newSkin.setSVG(svgData, rotationCenter);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Create a new PenSkin - a skin which implements a Scratch pen layer.
     * @returns {!int} the ID for the new skin.
     */
    createPenSkin () {
        const skinId = this._nextSkinId++;
        const newSkin = new PenSkin(skinId, this);
        this._allSkins[skinId] = newSkin;
        // tw: track id of pen skin
        this._penSkinId = skinId;
        // tw: high quality pen may have been enabled before the pen skin was created
        this._updateRenderQuality();
        return skinId;
    }

    /**
     * Create a new SVG skin using the text skin creator. The rotation center
     * is always placed at the top left.
     * @param {!string} type - either "say" or "think".
     * @param {!string} text - the text for the bubble.
     * @param {!boolean} pointsLeft - which side the bubble is pointing.
     * @param {!object} props - text props.
     * @returns {!int} the ID for the new skin.
     */
    createTextSkin (type, text, pointsLeft, props) {
        const skinId = this._nextSkinId++;
        const newSkin = new TextBubbleSkin(skinId, this);
        newSkin.setTextBubble(type, text, pointsLeft, props);
        this._allSkins[skinId] = newSkin;
        return skinId;
    }

    /**
     * Update an existing SVG skin, or create an SVG skin if the previous skin was not SVG.
     * @param {!int} skinId the ID for the skin to change.
     * @param {!string} svgData - new SVG to use.
     * @param {?Array<number>} rotationCenter Optional: rotation center of the skin. If not supplied, the center of the
     * skin will be used
     */
    updateSVGSkin (skinId, svgData, rotationCenter) {
        if (this._allSkins[skinId] instanceof SVGSkin) {
            this._allSkins[skinId].setSVG(svgData, rotationCenter);
            return;
        }

        const newSkin = new SVGSkin(skinId, this);
        newSkin.setSVG(svgData, rotationCenter);
        this._reskin(skinId, newSkin);
    }

    /**
     * Update an existing bitmap skin, or create a bitmap skin if the previous skin was not bitmap.
     * @param {!int} skinId the ID for the skin to change.
     * @param {!ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} imgData - new contents for this skin.
     * @param {!number} bitmapResolution - the resolution scale for a bitmap costume.
     * @param {?Array<number>} rotationCenter Optional: rotation center of the skin. If not supplied, the center of the
     * skin will be used
     */
    updateBitmapSkin (skinId, imgData, bitmapResolution, rotationCenter) {
        if (this._allSkins[skinId] instanceof BitmapSkin) {
            this._allSkins[skinId].setBitmap(
                imgData,
                bitmapResolution,
                rotationCenter
            );
            return;
        }

        const newSkin = new BitmapSkin(skinId, this);
        newSkin.setBitmap(imgData, bitmapResolution, rotationCenter);
        this._reskin(skinId, newSkin);
    }

    _reskin (skinId, newSkin) {
        const oldSkin = this._allSkins[skinId];
        this._allSkins[skinId] = newSkin;

        // Tell drawables to update
        for (const drawable of this._allDrawables) {
            if (drawable && drawable.skin === oldSkin) {
                drawable.skin = newSkin;
            }
        }
        oldSkin.dispose();
    }

    /**
     * Update a skin using the text skin creator.
     * @param {!int} skinId the ID for the skin to change.
     * @param {!string} type - either "say" or "think".
     * @param {!string} text - the text for the bubble.
     * @param {!boolean} pointsLeft - which side the bubble is pointing.
     * @param {!object} props - the text props.
     */
    updateTextSkin (skinId, type, text, pointsLeft, props) {
        if (this._allSkins[skinId] instanceof TextBubbleSkin) {
            this._allSkins[skinId].setTextBubble(type, text, pointsLeft, props);
            return;
        }

        const newSkin = new TextBubbleSkin(skinId, this);
        newSkin.setTextBubble(type, text, pointsLeft, props);
        this._reskin(skinId, newSkin);
    }

    /**
     * Update a skin using the text costume svg creator.
     * @param {!object} textState the state to apply.
     * @param {!boolean} pointsLeft - which side the bubble is pointing.
     * @returns {number} the the skin id
     */
    updateTextCostumeSkin (textState) {
        // update existing skin
        if (
            textState.skinId &&
            this._allSkins[textState.skinId] instanceof TextCostumeSkin
        ) {
            this._allSkins[textState.skinId].setTextAndStyle(textState);

            return textState.skinId;
        } // create and update a new skin

        const skinId = this._nextSkinId++;
        const newSkin = new TextCostumeSkin(skinId, this);
        this._allSkins[skinId] = newSkin;
        newSkin.setTextAndStyle(textState); // this._reskin(skinId, newSkin); // this is erroring- might be necessary?

        return skinId;
    }

    /**
     * Destroy an existing skin. Do not use the skin or its ID after calling this.
     * @param {!int} skinId - The ID of the skin to destroy.
     */
    destroySkin (skinId) {
        const oldSkin = this._allSkins[skinId];
        oldSkin.dispose();
        delete this._allSkins[skinId];
    }

    /**
     * Create a new Drawable and add it to the scene.
     * @param {string} group Layer group to add the drawable to
     * @returns {int} The ID of the new Drawable.
     */
    createDrawable (group) {
        if (
            !group ||
            !Object.prototype.hasOwnProperty.call(this._layerGroups, group)
        ) {
            log.warn('Cannot create a drawable without a known layer group');
            return RenderConstants.ID_NONE;
        }
        const drawableID = this._nextDrawableId++;
        const drawable = new Drawable(drawableID, this);
        this._allDrawables[drawableID] = drawable;
        this._addToDrawList(drawableID, group);
        // tw: implement high quality render
        drawable.setHighQuality(this.useHighQualityRender);
        drawable.skin = null;
        return drawableID;
    }

    // minimal stub so file is valid; real implementation may have more methods
    _createGeometry () {
        // create a simple quad buffer for fullscreen operations if needed
        const gl = this._gl;
        const arrays = {
            a_position: { numComponents: 2, data: [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1] },
            a_texCoord: { numComponents: 2, data: [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1] }
        };
        this._quadBufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);
    }

    _addToDrawList (drawableID, group) {
        const groupInfo = this._layerGroups[group];
        if (!groupInfo) {
            // if group doesn't exist yet, append at end
            this._layerGroups[group] = {
                groupIndex: this._groupOrdering.length,
                drawListOffset: this._drawList.length
            };
            this._groupOrdering.push(group);
            this._drawList.push(drawableID);
            return;
        }
        this._drawList.splice(groupInfo.drawListOffset, 0, drawableID);
        // update offsets for later groups
        for (const name of Object.keys(this._layerGroups)) {
            const info = this._layerGroups[name];
            if (info.groupIndex > groupInfo.groupIndex) {
                info.drawListOffset++;
            }
        }
    }

    _enterDrawBackground () {
        // stub for background draw region
    }

    _exitDrawBackground () {
        // stub for background draw region
    }

    onNativeSizeChanged () {
        // stub handler; external code may override
    }

    draw () {
        const gl = this._gl;
        if (!this.dirty) return;
        this.dirty = false;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(
            this._backgroundColor4f[0],
            this._backgroundColor4f[1],
            this._backgroundColor4f[2],
            this._backgroundColor4f[3]
        );
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

        // basic draw loop using default shader manager
        for (const id of this._drawList) {
            const drawable = this._allDrawables[id];
            if (!drawable) continue;
            drawable.draw(this._shaderManager, this._projection);
        }
    }
}

module.exports = RenderWebGL;
