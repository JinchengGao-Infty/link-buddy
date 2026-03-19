export default async function generateImage(input) {
  const { prompt, aspect_ratio = '1:1', size = '1K' } = input;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'GEMINI_API_KEY environment variable is not set' };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`;

  const body = {
    contents: [{
      parts: [{ text: prompt }],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspect_ratio,
        imageSize: size,
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `Gemini API error (${response.status}): ${text.slice(0, 500)}` };
  }

  const data = await response.json();

  const candidate = data.candidates?.[0];
  if (!candidate) {
    return { success: false, error: 'No candidates in Gemini response' };
  }

  const parts = candidate.content?.parts ?? [];
  let textResult = '';
  let imageData = null;
  let imageMimeType = 'image/png';

  for (const part of parts) {
    if (part.text) {
      textResult += part.text;
    }
    if (part.inline_data) {
      imageData = part.inline_data.data;
      imageMimeType = part.inline_data.mime_type || 'image/png';
    }
  }

  if (!imageData) {
    return {
      success: true,
      result: textResult || 'Gemini returned no image. The prompt may have been filtered.',
    };
  }

  return {
    success: true,
    result: textResult || `Generated image for: ${prompt}`,
    media: [{
      data: imageData,
      mimeType: imageMimeType,
      filename: 'generated-image.png',
    }],
  };
}
