//
// The player script observes the contents of the page for media elements to
// remotely control. Information regarding the media is sent to the host
// application to determine how playback should be handled. Certain playback
// events are also sent to the page such as play, pause, seek, and volume.
//

;(function() {
  console.debug(`Metastream player content script ${location.href}`)

  //=============================================================================
  // Setup communications between content script and background script.
  //=============================================================================

  // Listen for events from the main world to forward to the
  // background process
  const eventMiddleware = event => {
    const { data: action } = event
    if (typeof action !== 'object' || typeof action.type !== 'string') return

    if (action.type.startsWith('metastream-')) {
      // Send to background script
      chrome.runtime.sendMessage(action)
    }
  }
  window.addEventListener('message', eventMiddleware)

  // Forward host events to main world
  chrome.runtime.onMessage.addListener(action => {
    if (typeof action !== 'object' || typeof action.type !== 'string') return

    if (action.type == 'metastream-host-event') {
      window.postMessage(action.payload, location.origin)
      return
    }

    switch (action.type) {
      case 'navigate':
        history.go(Number(action.payload) || 0)
        break
      case 'reload':
        location.reload(Boolean(action.payload))
        break
      case 'stop':
        stop()
        break
    }
  })

  //=============================================================================
  // Improve visuals of image or video pages
  //=============================================================================

  const body = document.body

  function enhanceVideo(video) {
    Object.assign(video, {
      loop: false,
      controls: false
    })

    Object.assign(video.style, {
      minWidth: '100%',
      minHeight: '100%'
    })
  }

  function enhanceImage(image) {
    const { src } = image

    // Assume extension is correct because we can't get the MIME type
    const isGif = src.endsWith('gif')

    Object.assign(image.style, {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: null,
      cursor: null,
      webkitUserDrag: 'none'
    })

    // Create new image which doesn't inherit any default zoom behavior
    const img = image.cloneNode(true)
    body.replaceChild(img, image)

    if (!isGif) {
      let bg = document.createElement('div')
      Object.assign(bg.style, {
        backgroundImage: `url(${src})`,
        backgroundSize: 'cover',
        backgroundPosition: '50% 50%',
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: '-1',
        filter: 'blur(20px) brightness(0.66)',
        transform: 'scale(1.2)'
      })
      body.insertBefore(bg, body.firstChild)
    }
  }

  if (body && body.childElementCount === 1) {
    const video = document.querySelector('body > video[autoplay]')
    if (video) {
      enhanceVideo(video)
    }

    const image = document.querySelector('body > img')
    if (image) {
      enhanceImage(image)
    }
  }

  //=============================================================================
  // Main world script - modifies media in the main browser context.
  //=============================================================================

  // Code within function will be injected into main world.
  // No closure variables are allowed within the function body.
  const mainWorldScript = function() {
    // Injected by Metastream
    console.debug(`Metastream main world script ${location.href}`)

    //===========================================================================
    // Globals
    //===========================================================================

    function debounce(func, wait, immediate) {
      var timeout
      return function() {
        var context = this,
          args = arguments
        var later = function() {
          timeout = null
          if (!immediate) func.apply(context, args)
        }
        var callNow = immediate && !timeout
        clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) func.apply(context, args)
      }
    }

    /** https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState */
    const MediaReadyState = {
      HAVE_NOTHING: 0,
      HAVE_METADATA: 1,
      HAVE_CURRENT_DATA: 2,
      HAVE_FUTURE_DATA: 3,
      HAVE_ENOUGH_DATA: 4
    }

    const PlaybackState = {
      Idle: 0,
      Playing: 1,
      Paused: 2
    }

    const SEC2MS = 1000

    const noop = () => {}

    const mediaList = new Set()
    let player
    let activeMedia

    //===========================================================================
    // Communicate between main world and content script's isolated world.
    //===========================================================================

    // Dispatch event
    // main world -> content script world -> background -> metastream content script -> metastream app
    const dispatchMediaEvent = action => {
      window.postMessage({
        type: 'metastream-webview-event',
        payload: { type: 'message', payload: action }
      })
    }

    const eventMiddleware = event => {
      const { data: action } = event
      if (typeof action !== 'object' || typeof action.type !== 'string') return
      if (!player) return

      console.debug(`[Metastream Remote] Received player event`, action)

      switch (action.type) {
        case 'set-media-playback': {
          if (action.payload === PlaybackState.Playing) {
            player.play()
          } else if (action.payload === PlaybackState.Paused) {
            player.pause()
          }
          break
        }
        case 'seek-media':
          player.seek(action.payload)
          break
        case 'set-media-volume':
          player.setVolume(action.payload)
          break
      }
    }
    window.addEventListener('message', eventMiddleware)

    //===========================================================================
    // HTMLMediaPlayer class for active media element.
    //===========================================================================

    /** Interval time (ms) to detect video element. */
    const DETECT_INTERVAL = 500

    /** Threshold before we'll seek. */
    const SEEK_THRESHOLD = 100

    /** Abstraction around HTML video tag. */
    class HTMLMediaPlayer {
      constructor(media) {
        this.media = media

        this.onPlay = this.onPlay.bind(this)
        this.onVolumeChange = this.onVolumeChange.bind(this)
        this.onWaiting = this.onWaiting.bind(this)

        this.media.addEventListener('play', this.onPlay, false)
        this.media.addEventListener('volumechange', this.onVolumeChange, false)
      }

      dispatch(eventName, detail) {
        const e = new CustomEvent(eventName, { detail: detail, cancelable: true, bubbles: false })
        document.dispatchEvent(e)
        return e.defaultPrevented
      }

      play() {
        if (this.dispatch('metastreamplay')) return
        this.startWaitingListener()
        return this.media.play()
      }
      pause() {
        if (this.dispatch('metastreampause')) return
        this.stopWaitingListener()
        this.media.pause()
      }
      getCurrentTime() {
        return this.media.currentTime
      }
      getDuration() {
        return this.media.duration
      }
      seek(time) {
        if (this.dispatch('metastreamseek', time)) return

        // Infinity is generally used for a dynamically allocated media object
        // or live media
        const duration = this.getDuration() * SEC2MS
        if (duration === Infinity || !isValidDuration(duration)) {
          return
        }

        // Only seek if we're off by greater than our threshold
        if (this.timeExceedsThreshold(time)) {
          this.media.currentTime = time / 1000
        }
      }
      setVolume(volume) {
        // MUST SET THIS FIRST
        this.volume = volume

        this.media.volume = volume

        if (this.media.muted && volume > 0) {
          this.media.muted = false
        }
      }

      /** Only seek if we're off by greater than our threshold */
      timeExceedsThreshold(time) {
        const dt = Math.abs(time / 1000 - this.getCurrentTime()) * 1000
        return dt > SEEK_THRESHOLD
      }

      /** Set volume as soon as playback begins */
      onPlay() {
        if (typeof this.volume === 'number') {
          this.setVolume(this.volume)
        }
      }

      /** Prevent third-party service from restoring cached volume */
      onVolumeChange() {
        const { volume } = this
        if (volume && this.media.volume !== volume) {
          console.debug(
            `[Metastream Remote] Volume changed internally (${
              this.media.volume
            }), reverting to ${volume}`
          )
          this.setVolume(volume)
        }
      }

      startWaitingListener() {
        if (this._awaitingStart) return
        this.media.addEventListener('waiting', this.onWaiting, false)
      }

      stopWaitingListener() {
        this.media.removeEventListener('waiting', this.onWaiting, false)
        if (this._endWaiting) this._endWaiting()
      }

      /** Force start playback on waiting */
      onWaiting() {
        if (this._awaitingStart) return
        this._awaitingStart = true

        let timeoutId = null

        const onStarted = () => {
          this.media.removeEventListener('playing', onStarted, false)
          clearTimeout(timeoutId)

          if (this.media.paused) {
            this.media.play().catch(noop)

            // HACK: Clear buffering spinner
            setTimeout(() => {
              if (!this.media.paused) {
                this.media.pause()
                this.media.play().catch(noop)
              }
            }, 1000)
          }

          this._awaitingStart = false
          this._endWaiting = null
        }
        this._endWaiting = onStarted
        this.media.addEventListener('playing', onStarted, false)

        let startTime = this.media.currentTime
        let time = startTime
        let attempt = 1

        const ATTEMPT_INTERVAL = 200
        const tryPlayback = () => {
          console.debug(
            `Attempting to force start playback [#${attempt++}][networkState=${
              this.media.networkState
            }][readyState=${this.media.readyState}]`
          )
          time += ATTEMPT_INTERVAL / 1000

          const dt = Math.abs(time - startTime)
          if (dt > 1) {
            startTime = time
            this.seek(time * 1000)
          } else {
            this.dispatch('metastreampause') || this.media.pause()
            const playPromise = this.dispatch('metastreamplay') || this.media.play()
            if (playPromise && playPromise.then) playPromise.catch(noop)
          }

          if (this.media.readyState === 4) {
            onStarted()
            return
          }

          timeoutId = setTimeout(tryPlayback, ATTEMPT_INTERVAL)
        }

        const initialDelay = this._hasAttemptedStart ? 200 : 1000
        timeoutId = setTimeout(tryPlayback, initialDelay)
        this._hasAttemptedStart = true
      }
    }

    //===========================================================================
    // Autoplay
    //===========================================================================

    const AUTOPLAY_TIMEOUT = 3000
    let autoplayTimerId = -1

    const attemptAutoplay = () => {
      function descRectArea(a, b) {
        const areaA = a.width * a.height
        const areaB = b.width * b.height
        if (areaA > areaB) return -1
        if (areaA < areaB) return 1
        return 0
      }

      const videos = Array.from(mediaList).filter(media => media instanceof HTMLVideoElement)
      if (videos.length === 0) return

      const rects = videos.map(video => video.getBoundingClientRect())
      rects.sort(descRectArea)

      // Assumes largest video rect is most relevant
      const rect = rects[0]
      const playButton = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2
      )

      if (playButton instanceof HTMLButtonElement || playButton instanceof HTMLDivElement) {
        console.debug('Attempting autoplay click', playButton)
        playButton.click()
      }
    }

    //===========================================================================
    // Auto-fullscreen
    //===========================================================================

    let fullscreenContainer
    let fullscreenFrameId
    let fullscreenStyleElement
    let origDocumentOverflow

    function getOffset(el) {
      let x = 0
      let y = 0
      while (el && !isNaN(el.offsetLeft) && !isNaN(el.offsetTop)) {
        x += el.offsetLeft - el.scrollLeft
        y += el.offsetTop - el.scrollTop
        el = el.offsetParent
      }
      return { top: y, left: x }
    }

    function renderFullscreen() {
      document.body.style.overflow = 'none'

      const { offsetWidth: width, offsetHeight: height } = activeMedia
      const { left, top } = getOffset(activeMedia)
      const { innerWidth: viewportWidth, innerHeight: viewportHeight } = window
      const scale = viewportWidth / width

      let transform, transformOrigin

      // Apply transform if player is smaller than viewport
      if (scale >= 1.05) {
        const translateX = left
        const translateY = viewportHeight / 2 - (top + height / 2)
        transform = `translate(-${translateX}px, ${translateY}px) scale(${scale})`
        transformOrigin = `${left}px ${top + height / 2}px`
      }

      fullscreenContainer.style.transformOrigin = transformOrigin
      fullscreenContainer.style.transform = transform

      fullscreenFrameId = requestAnimationFrame(renderFullscreen)
    }

    function startAutoFullscreen() {
      console.debug('Starting autofullscreen', activeMedia)

      if (!(activeMedia instanceof HTMLVideoElement)) return

      origDocumentOverflow = document.body.style.overflow

      // Find container we can transform
      let container = activeMedia
      do {
        if (container && container.offsetWidth && container.offsetHeight) {
          fullscreenContainer = container
        }
      } while ((container = container.parentNode))

      // Hide all non-video elements
      const elem = document.createElement('style')
      elem.innerText = `
:not(video) {
  color: transparent !important;
  z-index: 0;
  background: transparent !important;
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
  overflow: none !important;
}

:not(video):empty {
  visibility: hidden !important;
}`
      fullscreenStyleElement = elem

      // Disabled as it can hide subtitles
      // document.head.appendChild(fullscreenStyleElement)

      fullscreenFrameId = requestAnimationFrame(renderFullscreen)
    }

    function stopAutoFullscreen() {
      console.debug('Stopping autofullscreen')
      if (origDocumentOverflow) {
        document.body.style.overflow = document.body.style.overflow
        origDocumentOverflow = undefined
      }
      if (fullscreenFrameId) {
        cancelAnimationFrame(fullscreenFrameId)
        fullscreenFrameId = undefined
      }
      if (fullscreenStyleElement) {
        fullscreenStyleElement.remove()
      }
      if (fullscreenContainer) {
        fullscreenContainer.style.transform = undefined
        fullscreenContainer.style.transformOrigin = undefined
        fullscreenContainer = undefined
      }
    }

    //===========================================================================
    // Track the active/primary media element
    //===========================================================================

    const MIN_DURATION = 1
    const MAX_DURATION = 60 * 60 * 20 * SEC2MS
    const isValidDuration = duration =>
      typeof duration === 'number' &&
      !isNaN(duration) &&
      duration < MAX_DURATION &&
      duration > MIN_DURATION

    const getVideoDuration = mediaElement => {
      let duration

      if (mediaElement) {
        duration = mediaElement.duration
        if (isValidDuration(duration)) return duration
      }

      // attempt to get duration from global 'player'
      const { player } = window
      if (typeof player === 'object' && typeof player.getDuration === 'function') {
        try {
          duration = player.getDuration()
        } catch (e) {}
        if (isValidDuration(duration)) return duration
      }
    }

    let prevDuration
    const signalReady = mediaElement => {
      const duration = getVideoDuration(mediaElement)
      if (prevDuration === duration) return

      dispatchMediaEvent({
        type: 'media-ready',
        payload: {
          duration: duration ? duration * SEC2MS : undefined
        }
      })

      prevDuration = duration
    }

    const setActiveMedia = media => {
      activeMedia = media
      player = new HTMLMediaPlayer(media)
      console.debug('Set active media', media, media.src, media.duration)
      window.MEDIA = media

      if (autoplayTimerId) {
        clearTimeout(autoplayTimerId)
        autoplayTimerId = -1
      }

      prevDuration = undefined

      stopAutoFullscreen()
      startAutoFullscreen()

      // TODO: Use MutationObserver to observe if video gets removed from DOM

      const onDurationChange = debounce(signalReady, 2000, media)
      media.addEventListener('durationchange', onDurationChange, false)
      signalReady(media)
    }

    const addMedia = media => {
      if (mediaList.has(media)) {
        return
      }

      console.debug('Add media', media, media.src, media.duration)
      mediaList.add(media)

      // Immediately mute to prevent being really loud
      media.volume = 0

      // Checks for media when it starts playing
      function checkMediaReady() {
        if (isNaN(media.duration)) {
          return false
        }

        // Wait for videos to appear in the DOM
        if (media instanceof HTMLVideoElement && !media.parentElement) {
          return false
        }

        if (media.readyState >= MediaReadyState.HAVE_CURRENT_DATA) {
          setActiveMedia(media)
          media.removeEventListener('playing', checkMediaReady)
          media.removeEventListener('durationchange', checkMediaReady)
          media.removeEventListener('canplay', checkMediaReady)
          return true
        }

        return false
      }

      if (media.paused || !checkMediaReady()) {
        media.addEventListener('playing', checkMediaReady)
        media.addEventListener('durationchange', checkMediaReady)
        media.addEventListener('canplay', checkMediaReady)

        clearTimeout(autoplayTimerId)
        autoplayTimerId = setTimeout(attemptAutoplay, AUTOPLAY_TIMEOUT)
      }
    }

    //===========================================================================
    // Observe media elements on the page
    //===========================================================================

    const listenForMedia = event => {
      const { target } = event
      if (target instanceof HTMLMediaElement) {
        addMedia(target)
      }
    }
    document.addEventListener('play', listenForMedia, true)
    document.addEventListener('durationchange', listenForMedia, true)

    // Proxy document.createElement to trap media elements created in-memory
    const origCreateElement = document.createElement
    const proxyCreateElement = function(tagName) {
      const element = origCreateElement.call(document, tagName)

      if (element instanceof HTMLMediaElement) {
        // Wait for attributes to be set
        setTimeout(addMedia, 0, element)
      }

      return element
    }
    proxyCreateElement.toString = origCreateElement.toString.bind(origCreateElement)
    document.createElement = proxyCreateElement

    // Process media elements from first.js
    const mediaElements = window.__metastreamMediaElements
    if (mediaElements) {
      Array.from(mediaElements).forEach(addMedia)
      window.__metastreamMediaElements = undefined
    }
  }

  // Inject inline script at top of DOM to execute as soon as possible
  const script = document.createElement('script')
  script.textContent = `(${mainWorldScript}());`
  if (document.head) {
    const { firstChild } = document.head
    if (firstChild) {
      document.head.insertBefore(script, firstChild)
    } else {
      document.head.appendChild(script)
    }
  } else {
    const id = setInterval(() => {
      try {
        document.documentElement.appendChild(script)
        clearInterval(id)
      } catch (e) {}
    }, 10)
  }
})()

// Don't serialize result
void 0
