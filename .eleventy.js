const url = require('url');
const querystring = require('querystring');
const path = require('path');
const { JSDOM } = require('jsdom');
const sharp = require('sharp');
const fetch = require('node-fetch');
const cache = require('./cache');
const {
  transformImgPath,
  logMessage,
  checkConfig,
} = require('./helpers');

// List of file extensions this plugin can handle (basically just what sharp supports)
const supportedExtensions = [
  'jpg',
  'jpeg',
  'gif',
  'png',
  'webp',
  'svg',
  'tiff',
];

// The default values for the plugin
const defaultLazyImagesConfig = {
  imgSelector: 'img',
  transformImgPath,
  cacheFile: '.lazyimages.json',
};

// A global to store the current config (saves us passing it around functions)
let lazyImagesConfig = defaultLazyImagesConfig;

// Reads the image object from the source file
const readImage = async (imageSrc) => {
  let image;

  if (imageSrc.startsWith('http') || imageSrc.startsWith('//')) {
    const res = await fetch(imageSrc);
    const buffer = await res.buffer();
    image = await sharp(buffer);
    return image;
  }

  try {
    image = await sharp(imageSrc);
    await image.metadata(); // just to confirm it can be read
  } catch (firstError) {
    try {
      // We couldn't read the file at the input path, but maybe it's
      // in './src', developers love to put things in './src'
      image = await sharp(`./src/${imageSrc}`);
      await image.metadata();
    } catch (secondError) {
      throw firstError;
    }
  }

  return image;
};

// Gets the image width+height+LQIP from the cache, or generates them if not found
const getImageData = async (imageSrc) => {
  const { cacheFile } = lazyImagesConfig;

  let imageData = cache.read(imageSrc);

  if (imageData) {
    return imageData;
  }

  logMessage(`started processing ${imageSrc}`);

  const image = await readImage(imageSrc);
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;

  imageData = {
    width,
    height,
  };

  logMessage(`finished processing ${imageSrc}`);
  cache.update(cacheFile, imageSrc, imageData);
  return imageData;
};

// Adds the attributes to the image element
const processImage = async (imgElem, options) => {
  const { transformImgPath } = lazyImagesConfig;

  if (imgElem.src.startsWith('data:')) {
    logMessage('skipping image with data URI');
    return;
  }

  const imgPath = transformImgPath(imgElem.src, options);
  const parsedUrl = url.parse(imgPath);
  let fileExt = path.extname(parsedUrl.pathname).substr(1);

  if (!fileExt) {
    // Twitter and similar pass the file format in the querystring, e.g. "?format=jpg"
    fileExt = querystring.parse(parsedUrl.query).format;
  }

  if (!imgElem.getAttribute('loading')) imgElem.setAttribute('loading', 'lazy');

  if (fileExt && !supportedExtensions.includes(fileExt.toLowerCase())) {
    logMessage(`${fileExt} placeholder not supported: ${imgPath}`);
    return;
  }

  try {
    const image = await getImageData(imgPath);

    // Don't set width/height for vector images
    if (fileExt === 'svg') {
      return;
    }

    const widthAttr = imgElem.getAttribute('width');
    const heightAttr = imgElem.getAttribute('height');

    if (!widthAttr && !heightAttr) {
      imgElem.setAttribute('width', image.width);
      imgElem.setAttribute('height', image.height);
    } else if (widthAttr && !heightAttr) {
      const ratioHeight = (image.height * widthAttr) / image.width;
      imgElem.setAttribute('height', Math.round(ratioHeight));
    } else if (heightAttr && !widthAttr) {
      const ratioWidth = (image.width * heightAttr) / image.height;
      imgElem.setAttribute('width', Math.round(ratioWidth));
    }
  } catch (e) {
    logMessage(`${e.message}: ${imgPath}`);
  }
};

// Scans the output HTML for images, processes them, & appends the init script
const transformMarkup = async (rawContent, outputPath) => {
  const { imgSelector } = lazyImagesConfig;
  let content = rawContent;

  if (outputPath && outputPath.endsWith('.html')) {
    const dom = new JSDOM(content);
    const images = [...dom.window.document.querySelectorAll(imgSelector)];

    if (images.length > 0) {
      logMessage(`found ${images.length} images in ${outputPath}`);
      await Promise.all(
        images.map((image) => processImage(image, { outputPath }))
      );
      logMessage(`processed ${images.length} images in ${outputPath}`);

      content = dom.serialize();
    }
  }

  return content;
};

// Export as 11ty plugin
module.exports = {
  initArguments: {},
  configFunction: (eleventyConfig, pluginOptions = {}) => {
    lazyImagesConfig = {
      ...defaultLazyImagesConfig,
      ...pluginOptions,
    };

    checkConfig(lazyImagesConfig, defaultLazyImagesConfig);
    cache.load(lazyImagesConfig.cacheFile);
    eleventyConfig.addTransform('lazyimages', transformMarkup);
  },
};
