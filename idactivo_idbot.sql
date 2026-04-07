-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Servidor: localhost:3306
-- Tiempo de generación: 07-04-2026 a las 14:30:39
-- Versión del servidor: 5.7.23-23
-- Versión de PHP: 8.1.34

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Base de datos: `idactivo_idbot`
--

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `admins`
--

CREATE TABLE `admins` (
  `id` int(11) NOT NULL,
  `username` varchar(100) COLLATE utf8_unicode_ci NOT NULL,
  `password` varchar(255) COLLATE utf8_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

--
-- Volcado de datos para la tabla `admins`
--

INSERT INTO `admins` (`id`, `username`, `password`, `created_at`) VALUES
(1, 'admin', '$2a$10$aSRinrcDS9PJE8h.nc36tOG97bUV9FUOA./dUpOqVbQh1Pw2o9jpy', '2026-04-06 21:54:13');

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `users`
--

CREATE TABLE `users` (
  `id` int(11) NOT NULL,
  `phone` varchar(20) COLLATE utf8_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `company` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `event_name` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `chosen_option` varchar(10) COLLATE utf8_unicode_ci DEFAULT NULL,
  `state` varchar(50) COLLATE utf8_unicode_ci NOT NULL DEFAULT 'WAITING_NAME',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `works`
--

CREATE TABLE `works` (
  `id` int(11) NOT NULL,
  `name` varchar(255) COLLATE utf8_unicode_ci NOT NULL,
  `description` text COLLATE utf8_unicode_ci,
  `pdf_url` varchar(500) COLLATE utf8_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

--
-- Volcado de datos para la tabla `works`
--

INSERT INTO `works` (`id`, `name`, `description`, `created_at`) VALUES
(1, 'prueba', 'solo es una prueba', '2026-04-06 22:01:03');

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `work_images`
--

CREATE TABLE `work_images` (
  `id` int(11) NOT NULL,
  `work_id` int(11) NOT NULL,
  `image_url` varchar(500) COLLATE utf8_unicode_ci NOT NULL,
  `sort_order` int(11) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

--
-- Volcado de datos para la tabla `work_images`
--

INSERT INTO `work_images` (`id`, `work_id`, `image_url`, `sort_order`, `created_at`) VALUES
(1, 1, 'https://idactivos.digital/backid/uploads/img-1-1775512863-190389.jpg', 0, '2026-04-06 22:01:03'),
(2, 1, 'https://idactivos.digital/backid/uploads/img-1-1775512863-998663.png', 1, '2026-04-06 22:01:03'),
(3, 1, 'https://idactivos.digital/backid/uploads/img-1-1775512863-256405.png', 2, '2026-04-06 22:01:03'),
(4, 1, 'https://idactivos.digital/backid/uploads/img-1-1775512863-474050.png', 3, '2026-04-06 22:01:03');

--
-- Índices para tablas volcadas
--

--
-- Indices de la tabla `admins`
--
ALTER TABLE `admins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`);

--
-- Indices de la tabla `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `phone` (`phone`);

--
-- Indices de la tabla `works`
--
ALTER TABLE `works`
  ADD PRIMARY KEY (`id`);

--
-- Indices de la tabla `work_images`
--
ALTER TABLE `work_images`
  ADD PRIMARY KEY (`id`),
  ADD KEY `work_id` (`work_id`);

--
-- AUTO_INCREMENT de las tablas volcadas
--

--
-- AUTO_INCREMENT de la tabla `admins`
--
ALTER TABLE `admins`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT de la tabla `users`
--
ALTER TABLE `users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT de la tabla `works`
--
ALTER TABLE `works`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT de la tabla `work_images`
--
ALTER TABLE `work_images`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- Restricciones para tablas volcadas
--

--
-- Filtros para la tabla `work_images`
--
ALTER TABLE `work_images`
  ADD CONSTRAINT `work_images_ibfk_1` FOREIGN KEY (`work_id`) REFERENCES `works` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
