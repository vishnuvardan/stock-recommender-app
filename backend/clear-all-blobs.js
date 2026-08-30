import dotenv from 'dotenv';
import { list, del } from '@vercel/blob';

// Load environment variables from .env
dotenv.config();

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

if (!blobToken) {
  console.error('Error: BLOB_READ_WRITE_TOKEN is not defined in .env');
  process.exit(1);
}

async function clearAllBlobs() {
  console.log('Fetching all blobs from Vercel Blob storage...');
  let hasMore = true;
  let cursor;
  let deletedCount = 0;

  while (hasMore) {
    const response = await list({
      cursor,
      token: blobToken
    });

    if (response.blobs.length === 0) {
      console.log('No blobs found in storage.');
      break;
    }

    console.log(`Found ${response.blobs.length} blobs. Deleting...`);
    const urls = response.blobs.map(blob => blob.url);
    await del(urls, { token: blobToken });
    deletedCount += urls.length;
    console.log(`Deleted ${urls.length} blobs in this batch.`);

    hasMore = response.hasMore;
    cursor = response.cursor;
  }

  console.log(`\nSuccess: Cleared Vercel Blob memory. Total deleted: ${deletedCount} blobs.`);
}

clearAllBlobs().catch(error => {
  console.error('Fatal error running clear-all-blobs script:', error);
  process.exit(1);
});
