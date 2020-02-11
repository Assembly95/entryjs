import { GEHelper } from '../graphicEngine/GEHelper';
import * as posenet from '@tensorflow-models/posenet';
import VideoWorker from './workers/video.worker';
// input resolution setting
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 360;

// canvasVideo SETTING
const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 270;

const worker = new VideoWorker();

class VideoUtils {
    constructor() {
        //with purpose of utilizing same value outside
        this.CANVAS_WIDTH = CANVAS_WIDTH;
        this.CANVAS_HEIGHT = CANVAS_HEIGHT;
        this.video = null;
        this.canvasVideo = null;
        this.flipStatus = {
            horizontal: false,
            vertical: false,
        };
        this.motionStatus = {
            total: 0,
            right: 0,
            left: 0,
            top: 0,
            bottom: 0,
        };
        this.objectDetected = [];
        this.isMobileNetInit = false;
        this.mobileNet = null;
        this.poses = null;
        this.isInitialized = false;
        this.videoOnLoadHandler = this.videoOnLoadHandler.bind(this);
        this.initDrawUserPoints = this.initDrawUserPoints.bind(this);
    }

    reset() {
        this.turnOnWebcam();
        if (!this.flipStatus.horizontal) {
            this.setOptions('hflip');
        }
        if (this.flipStatus.vertical) {
            this.setOptions('vflip');
        }
        GEHelper.resetCanvasBrightness(this.canvasVideo);
        GEHelper.setVideoAlpha(this.canvasVideo, 50);
        GEHelper.tickByEngine();
        this.poses = null;
    }

    async initialize() {
        if (this.isInitialized) {
            return;
        }
        this.isInitialized = true;

        if (!this.inMemoryCanvas) {
            this.inMemoryCanvas = document.createElement('canvas');
            this.inMemoryCanvas.width = CANVAS_WIDTH;
            this.inMemoryCanvas.height = CANVAS_HEIGHT;
        }

        navigator.getUserMedia =
            navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
        if (navigator.getUserMedia) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: 'user',
                        width: VIDEO_WIDTH,
                        height: VIDEO_HEIGHT,
                    },
                });

                this.stream = stream;
                const video = document.createElement('video');
                video.srcObject = stream;
                video.width = CANVAS_WIDTH;
                video.height = CANVAS_HEIGHT;
                this.canvasVideo = GEHelper.getVideoElement(video);
                this.video = video;
                video.onloadedmetadata = this.videoOnLoadHandler;
            } catch (err) {
                console.log(err);
                this.isInitialized = false;
            }
        } else {
            console.log('getUserMedia not supported');
        }
    }

    async initializePosenet() {
        if (this.isMobileNetInit) {
            return;
        }
        this.mobileNet = await posenet.load({
            architecture: 'MobileNetV1',
            outputStride: 16,
            inputResolution: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
            multiplier: 1,
        });
        this.isMobileNetInit = true;
    }

    initDrawUserPoints() {
        const ctx = Entry.stage.canvas.canvas.getContext('2d');
        if (this.poses) {
            this.drawPoints(ctx, this.poses.predictions);
            this.drawSkeletons(ctx, this.poses.adjacents);
        }
        requestAnimationFrame(this.initDrawUserPoints.bind(this));
    }
    drawPoints(ctx, poses) {
        if (!poses) {
            return;
        }
        poses.map((pose) => {
            pose.keypoints.map((item) => {
                GEHelper.drawPosePoint(ctx, item.position);
            });
        });
    }

    drawSkeletons(ctx, adjacents) {
        if (!adjacents) {
            return;
        }
        adjacents.forEach((adjacentList) => {
            adjacentList.forEach((pair) => {
                GEHelper.drawPoseSkeleton(ctx, pair[0].position, pair[1].position);
            });
        });
    }

    videoOnLoadHandler() {
        Entry.addEventListener('dispatchEventDidToggleStop', this.reset.bind(this));
        this.video.play();
        this.turnOnWebcam();
        this.initDrawUserPoints();
        if (window.Worker) {
            if (this.isMobileNetInit) {
                return;
            }
            worker.onmessage = (e) => {
                const { type, message } = e.data;
                switch (type) {
                    case 'pose':
                        this.poses = message;
                        break;
                    case 'init':
                        this.isMobileNetInit = true;
                        break;
                    case 'motion':
                        this.motionStatus = message;
                        break;
                    case 'coco':
                        this.objectDetected = message;
                }
            };
            worker.postMessage({
                type: 'init',
                width: CANVAS_WIDTH,
                height: CANVAS_HEIGHT,
            });

            const [track] = this.stream.getVideoTracks();
            this.imageCapture = new ImageCapture(track);
            setInterval(() => {
                const context = this.inMemoryCanvas.getContext('2d');
                context.drawImage(this.video, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
                const imageData = context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
                worker.postMessage({
                    type: 'estimate',
                    imageData,
                });
            }, 100);
        } else {
            this.initializePosenet();
        }
    }

    async estimatePoseOnImage() {
        // load the posenet model from a checkpoint
        if (!this.isMobileNetInit) {
            return [];
        }
        if (!window.Worker) {
            try {
                const predictions = await this.mobileNet.estimateMultiplePoses(this.video, {
                    flipHorizontal: this.flipStatus.horizontal,
                    maxDetections: 4,
                    scoreThreshold: 0.5,
                    nmsRadius: 20,
                });
                const adjacents = [];

                predictions.forEach((pose) => {
                    const adjacentMap = posenet.getAdjacentKeyPoints(pose.keypoints, 0.2);
                    adjacents.push(adjacentMap);
                });

                this.poses = { predictions, adjacents };

                return this.poses.predictions;
            } catch (err) {
                if (!this.isMobileNetInit) {
                    console.log(err);
                }
                return [];
            }
        }
        return this.poses;
    }

    async checkUserCamAvailable() {
        try {
            await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            return true;
        } catch (err) {
            return false;
        }
    }
    // camera power
    cameraSwitch(value) {
        switch (value) {
            case 'on':
                this.turnOnWebcam();
                break;
            default:
                this.turnOffWebcam();
                break;
        }
    }

    turnOffWebcam() {
        GEHelper.turnOffWebcam(this.canvasVideo);
    }

    turnOnWebcam() {
        GEHelper.drawVideoElement(this.canvasVideo);
        if (!this.flipStatus.horizontal) {
            this.setOptions('hflip');
        }
    }
    // option change
    setOptions(target, value) {
        if (!this.canvasVideo) {
            return;
        }
        switch (target) {
            case 'brightness':
                GEHelper.setVideoBrightness(this.canvasVideo, value);
                break;
            case 'opacity':
                GEHelper.setVideoAlpha(this.canvasVideo, value);
                break;
            case 'hflip':
                this.flipStatus.horizontal = !this.flipStatus.horizontal;
                worker.postMessage({
                    type: 'option',
                    option: { flipStatus: this.flipStatus },
                });
                GEHelper.hFlipVideoElement(this.canvasVideo);
                break;
            case 'vflip':
                this.flipStatus.vertical = !this.flipStatus.vertical;
                GEHelper.vFlipVideoElement(this.canvasVideo);
                break;
        }
    }

    // videoUtils.destroy does not actually destroy singletonClass, but instead resets the whole stuff except models to be used
    destroy() {
        this.turnOffWebcam();
        this.stream.getTracks().forEach((track) => {
            track.stop();
        });
        this.video = null;
        this.canvasVideo = null;
        this.flipStatus = {
            horizontal: false,
            vertical: false,
        };

        this.mobileNet = null;
        this.poses = null;
        this.isInitialized = false;
    }
}

//Entry 네임스페이스에는 존재하지 않으므로 외부에서 사용할 수 없다.
export default new VideoUtils();