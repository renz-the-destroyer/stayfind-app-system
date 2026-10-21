// middleware/sanitize.js
//
// Server-side safety net for everything users type or upload. Even if a page
// forgets to escape something, bad data can no longer get into the database.
//
//  1. Short text fields (names, titles, locations, comments...) lose any < or >
//     characters, so HTML tags can't be stored in them.
//  2. Listing photos (`images`, `thumbnail`) must be Cloudinary links. Anything
//     else (javascript:, other websites, broken quotes) is rejected.
//  3. Landlord documents must be real base64 image data (jpeg / png / webp).
//
// If you ever move photo hosting away from Cloudinary, change CLOUDINARY_URL.

const TEXT_FIELDS = [
    'full_name', 'address', 'contact',
    'title', 'location', 'amenities', 'category',
    'comment', 'landlord_doc_name'
];

const stripAngles = (v) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim() : v);

const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_.\-\/%]+$/i;
const DOC_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/;

// Photos/documents are sent as one string joined by '|||'. Every part must pass.
function everyPart(value, test) {
    return String(value)
        .split('|||')
        .map((s) => s.trim())
        .filter(Boolean)
        .every(test);
}

const isBlank = (v) => v === undefined || v === null || v === '';

exports.sanitizeBody = (req, res, next) => {
    const b = req.body;
    if (!b || typeof b !== 'object') return next();

    for (const key of TEXT_FIELDS) {
        if (typeof b[key] === 'string') b[key] = stripAngles(b[key]);
    }

    for (const key of ['images', 'thumbnail']) {
        if (!isBlank(b[key]) && !everyPart(b[key], (u) => CLOUDINARY_URL.test(u))) {
            return res.status(400).json({
                success: false,
                message: 'Invalid photo link. Photos must be uploaded through StayFind.'
            });
        }
    }

    if (!isBlank(b.landlord_documents) && !everyPart(b.landlord_documents, (d) => DOC_DATA_URL.test(d))) {
        return res.status(400).json({
            success: false,
            message: 'Invalid document file. Please upload clear photos (JPG, PNG or WebP).'
        });
    }

    next();
};
