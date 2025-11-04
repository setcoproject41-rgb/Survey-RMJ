// next.config.js

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Menambahkan konfigurasi output: 'standalone' untuk mengoptimalkan
    // deployment sebagai Serverless Function. Ini membantu menghindari
    // masalah direktori output yang hilang saat tidak ada frontend Next.js.
    output: 'standalone', 
    
    // Opsional: Menonaktifkan optimasi image default Next.js 
    // karena kita hanya menggunakan API Routes.
    images: {
        unoptimized: true,
    }
};

module.exports = nextConfig;
