const express = require('express');
const pool = require('./db');
const xlsx = require('xlsx');
const { Pool } = require('pg');
const session = require('express-session');
//const authRoutes = require('./auth');
const app = express();
const path = require('path');
const router = express.Router();
const multer = require('multer');
const fs = require('fs-extra');
const bcrypt = require('bcrypt'); 
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();

//const morgan = require('morgan');

// Middleware para procesar JSON en el cuerpo de las solicitudes
app.use(express.json());
//app.use(morgan('dev'));

const port = 3002;



app.use(cors({
  origin: 'http://localhost:3003', // Permite solicitudes del frontend
  credentials: true, // Si se están usando cookies
}));


pool.connect((err, client, release) => {
    if (err) {
      return console.error('Error al conectar a la base de datos:', err.stack);
    }
    //console.log('Conectado a la base de datos');
    release(); // Libera el cliente una vez que hayas terminado
  });


// Ruta de autenticación
app.post('/usuarios/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Consulta a la base de datos para obtener el usuario por username
        const result = await pool.query('SELECT * FROM usuario WHERE usuario = $1 and activo=true', [username]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }

        const user = result.rows[0];
        const hashedPassword = user.pwd;

        const passwordMatch = await bcrypt.compare(password, hashedPassword);

        if (passwordMatch) {
            // Usar la clave secreta del archivo .env
            const token = jwt.sign(
                { userId: user.usuario_id, username: user.usuario }, 
                process.env.JWT_SECRET, // Acceder a la clave secreta
                { expiresIn: '1h' }
            );

            res.json({
                success: true,
                message: 'Autenticación exitosa',
                token: token,
                user: {
                    nombre: user.nombre_apellido,
                    rol: user.rol
                }
            });
        } else {
            res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});


//Ruta de listado de usuarios
app.get('/usuarios/listar/:id', async (req, res) => {
    try {
      const { id } = req.params;
      //console.log(id);
      //const { canje_id } = req.body
      const result = await pool.query("select * from usuario where usuario_id= $1", [id]);
      res.json(result.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  });


  //Ruta de listado de roles
app.get('/usuarios/roles', async (req, res) => {
    try {
      //const { id } = req.params;
      //console.log(id);
      //const { canje_id } = req.body
      const result = await pool.query("select * from rol order by rol_id");
      res.json(result.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  });

  //Ruta de listado de puestos
  app.get('/usuarios/puestos', async (req, res) => {
    try {
      //const { id } = req.params;
      //console.log(id);
      //const { canje_id } = req.body
      const result = await pool.query("select * from puesto order by puesto_id");
      res.json(result.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  });


//Ruta de busqueda de usuarios por nombre y apellido
  app.get('/usuarios/buscar/:criterio', async (req, res) => {
    const { criterio } = req.params;
    const { page = 1, limit = 10 } = req.query; // Parámetros de paginación opcionales
  
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);
    const offset = (pageNumber - 1) * limitNumber;
  
    try {
      // Búsqueda de usuarios con criterio y paginación
      const result = await pool.query(
        `SELECT *  
        FROM usuario as a inner join rol as b on a.rol_id = b.rol_id
        inner join puesto as c on a.puesto_id = c.puesto_id
        WHERE nombre_apellido ILIKE '%' || $1 || '%' and a.activo = true
        ORDER BY usuario_id 
        LIMIT $2 OFFSET $3`,
        [criterio, limitNumber, offset]
      );
  
      // Contar el total de usuarios que coinciden con el criterio
      const countResult = await pool.query(
        `SELECT COUNT(*) 
        FROM usuario as a
        WHERE nombre_apellido ILIKE '%' || $1 || '%' and a.activo = true`,
        [criterio]
      );
  
      const totalUsuarios = parseInt(countResult.rows[0].count, 10);
      const totalPages = Math.ceil(totalUsuarios / limitNumber);
  
      // Devolver los resultados de la búsqueda y el total de páginas
      res.json({
        usuarios: result.rows,
        totalPages: totalPages,
        currentPage: pageNumber,
        totalUsuarios: totalUsuarios,
      });
    } catch (err) {
      console.error('Error en la búsqueda de usuarios:', err.message);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  });
  

  //Ruta para importar planillas desde FE
// Configuración de multer para subir archivos
const upload = multer({ dest: 'uploads/' });  // Subir temporalmente a 'uploads/'

// Ruta para importar planillas
app.post('/planillas/importar', upload.single('file'), async (req, res) => {
  const { descripcion, usuario_id } = req.body;
  const file = req.file;
  
  if (!file || !descripcion || !usuario_id) {
    return res.status(400).json({ message: 'Todos los campos son obligatorios.' });
  }

  // Leer el archivo Excel
  try {
    const workbook = xlsx.readFile(file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

    if (rows.length === 0) {
      return res.status(400).json({ message: 'El archivo está vacío.' });
    }

    const client = await pool.connect();
    try {
      // Iniciar la transacción
      await client.query('BEGIN');

      // 1. Insertar en la tabla 'planilla' y obtener el planilla_id generado
      const insertPlanillaQuery = `
        INSERT INTO planilla (planilla, usuario_id, planilla_desc)
        VALUES ($1, $2, $3)
        RETURNING planilla_id
      `;
      const planillaNombre = file.originalname; // Nombre original del archivo
      const planillaResult = await client.query(insertPlanillaQuery, [planillaNombre, usuario_id, descripcion]);
      const planillaId = planillaResult.rows[0].planilla_id;

      // 2. Mover el archivo a la carpeta "/planillas" con el nuevo nombre: planilla_id + nombre_archivo
      const newFileName = `${planillaId}_${planillaNombre}`;
      const newFilePath = path.join(__dirname, 'planillas', newFileName); // Ruta física donde se guardará el archivo

      // Crear la carpeta "planillas" si no existe
      const planillasDir = path.join(__dirname, 'planillas');
      if (!fs.existsSync(planillasDir)) {
        fs.mkdirSync(planillasDir);
      }

      // Mover el archivo desde la carpeta temporal 'uploads/' a '/planillas'
      fs.renameSync(file.path, newFilePath);

      // Actualizar el nombre del archivo en la tabla 'planilla' con el nuevo nombre (planilla_id + nombre_archivo)
      const updatePlanillaQuery = `
        UPDATE planilla
        SET planilla = $1
        WHERE planilla_id = $2
      `;
      await client.query(updatePlanillaQuery, [newFileName, planillaId]);

      // 3. Insertar en la tabla 'planilla_registros' usando el planilla_id generado
      const insertRegistroQuery = `
        INSERT INTO planilla_registro (planilla_id, legajo, categoria, empleado, fecha_citacion, horario)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;

      for (const row of rows) {
        const { Legajo, CATEGORIA: Categoria, Empleado, "Fecha_Citación": Fecha_Citacion, Horario } = row;
        console.log(row);
        console.log({ Legajo, Categoria, Empleado, Fecha_Citacion, Horario });
        // Asegurarse de que los campos obligatorios estén presentes en el Excel
        if (!Legajo || !Categoria || !Empleado || !Fecha_Citacion || !Horario) {
          throw new Error('El archivo Excel tiene registros con campos faltantes.');
        }

        // Insertar cada fila del Excel en la tabla 'planilla_registros'
        await client.query(insertRegistroQuery, [
          planillaId,
          Legajo,
          Categoria,
          Empleado,
          Fecha_Citacion,
          Horario,
        ]);
      }

      // Confirmar la transacción
      await client.query('COMMIT');

      res.status(200).json({ message: 'Planilla importada exitosamente.' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error al importar la planilla:', error);
      res.status(500).json({ message: 'Error al importar la planilla.' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error al procesar el archivo:', error);
    res.status(500).json({ message: 'Error al procesar el archivo Excel.' });
  }
});



  //Ruta de busqueda de planillas por nombre de archivo
  app.get('/planillas/buscar/:criterio', async (req, res) => {
    const { criterio } = req.params;
    const { page = 1, limit = 10 } = req.query; // Parámetros de paginación opcionales
  
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);
    const offset = (pageNumber - 1) * limitNumber;
  
    try {
      // Búsqueda de usuarios con criterio y paginación
      const result = await pool.query(
        `SELECT *  
        FROM planilla as a inner join usuario as b on a.usuario_id = b.usuario_id
        WHERE planilla ILIKE '%' || $1 || '%' and a.activa = true
        ORDER BY planilla_id 
        LIMIT $2 OFFSET $3`,
        [criterio, limitNumber, offset]
      );
  
      // Contar el total de usuarios que coinciden con el criterio
      const countResult = await pool.query(
        `SELECT COUNT(*) 
        FROM planilla as a
        WHERE planilla ILIKE '%' || $1 || '%' and a.activa = true`,
        [criterio]
      );
  
      const totalPlanillas = parseInt(countResult.rows[0].count, 10);
      const totalPages = Math.ceil(totalPlanillas / limitNumber);
  
      // Devolver los resultados de la búsqueda y el total de páginas
      res.json({
        planillas: result.rows,
        totalPages: totalPages,
        currentPage: pageNumber,
        totalPlanillas: totalPlanillas,
      });
    } catch (err) {
      console.error('Error en la búsqueda de planillas:', err.message);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  });




// Ruta para eliminar lógicamente un usuario
app.get('/usuarios/eliminar/:usuario_id', async (req, res) => {
    const { usuario_id } = req.params;
  
    try {
      // Consulta SQL para actualizar el campo "activo" a false
      const updateQuery = 'UPDATE usuario SET activo = false WHERE usuario_id = $1';
      const result = await pool.query(updateQuery, [usuario_id]);
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
  
      res.status(200).json({ message: `Usuario con ID ${usuario_id} desactivado exitosamente` });
    } catch (error) {
      console.error('Error al desactivar usuario:', error);
      res.status(500).json({ error: 'Error al desactivar usuario' });
    }
  });
// Ruta para listar planillas con paginación
app.get('/planillas/listar', async (req, res) => {
    const { page = 1, limit = 10 } = req.query; // page y limit son opcionales, por defecto 1 y 10
    const offset = (page - 1) * limit;
  
    try {
      // Obtener usuarios paginados
      const result = await pool.query(
        `SELECT * FROM planilla 
        as a inner join usuario as b on a.usuario_id = b.usuario_id
        where a.activa=true
         ORDER BY a.planilla_id LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
  
      // Obtener el total de usuarios para calcular el número de páginas
      const countResult = await pool.query('SELECT COUNT(*) FROM planilla as a where a.activa=true');
      const totalPlanillas = parseInt(countResult.rows[0].count, 10);
      const totalPages = Math.ceil(totalPlanillas / limit);
  
      // Devolver los usuarios y el total de páginas
      res.json({
        planillas: result.rows,
        totalPages: totalPages,
      });
    } catch (error) {
      console.error('Error al listar planillas:', error);
      res.status(500).json({ message: 'Error interno del servidor' });
    }
  });

// Ruta para listar usuarios con paginación
app.get('/usuarios/listar', async (req, res) => {
    const { page = 1, limit = 10 } = req.query; // page y limit son opcionales, por defecto 1 y 10
    const offset = (page - 1) * limit;
  
    try {
      // Obtener usuarios paginados
      const result = await pool.query(
        `SELECT * FROM usuario 
        as a inner join rol as b on a.rol_id = b.rol_id
        inner join puesto as c on a.puesto_id = c.puesto_id where a.activo=true
         ORDER BY a.usuario_id LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
  
      // Obtener el total de usuarios para calcular el número de páginas
      const countResult = await pool.query('SELECT COUNT(*) FROM usuario as a where a.activo=true');
      const totalUsuarios = parseInt(countResult.rows[0].count, 10);
      const totalPages = Math.ceil(totalUsuarios / limit);
  
      // Devolver los usuarios y el total de páginas
      res.json({
        usuarios: result.rows,
        totalPages: totalPages,
      });
    } catch (error) {
      console.error('Error al listar usuarios:', error);
      res.status(500).json({ message: 'Error interno del servidor' });
    }
  });


// Ruta para actualizar el último acceso
app.post('/usuarios/ultimo_login', async (req, res) => {
    try {
        // Obtener el token de autorización
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ success: false, message: 'Token no proporcionado' });
        }

        // Verificar el token y obtener el payload (suponiendo que usas jwt)
        const decoded = jwt.verify(token, process.env.JWT_SECRET); // Asegúrate de que tu clave secreta esté en .env
        
        const username = decoded.username; // O el campo que uses en tu token

        // Actualizar el campo ultimo_acceso en la base de datos
        const result = await pool.query(
            'UPDATE usuario SET ultimo_acceso = now() WHERE usuario = $1',
            [username]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }

        return res.json({ success: true, message: 'Último acceso actualizado' });
    } catch (err) {
        console.error(err.message);
        return res.status(500).json({ error: 'Error en el servidor' });
    }
});


// Ruta para dar de alta a un nuevo usuario
app.post('/usuarios/crear', async (req, res) => {
    try {
        
        const { usuario, nombre_apellido, mail, rol_id, puesto_id, pwd, legajo, telefono } = req.body;
        const bcrypt = require('bcrypt');
        const hashedPwd = await bcrypt.hash(pwd, 10);

        // Validar que todos los campos necesarios estén presentes
        if (!usuario || !nombre_apellido || !mail || !rol_id || !puesto_id || !pwd || !legajo || !telefono) {
            return res.status(400).json({ error: 'Todos los campos son obligatorios' });
        }

        // Ejecutar el insert en la base de datos
        const result = await pool.query(
            `INSERT INTO usuario (usuario, nombre_apellido, mail, rol_id, puesto_id, pwd, legajo, telefono) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING *`,  // Retornar los datos del usuario recién creado
            [usuario, nombre_apellido, mail, rol_id, puesto_id, hashedPwd, legajo, telefono]
        );

        // Devolver el usuario insertado como respuesta
        res.status(201).json({
            message: 'Usuario creado exitosamente',
            user: result.rows[0]  // Retorna el primer (y único) registro
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

//Ruta de modificacion de datos
app.put('/usuarios/modificar', async (req, res) => {
    const { usuario_id, usuario, nombre_apellido, mail, rol_id, puesto_id, pwd, legajo, telefono } = req.body;
   
    
    // Validar que el usuario_id esté presente
    if (!usuario_id) {
        return res.status(400).json({ error: 'El campo usuario_id es obligatorio' });
    }

    // Construir la consulta dinámicamente con los campos que se quieran modificar
    let updateFields = [];
    let queryParams = [];
    let counter = 1;

    // Agregar los campos a modificar dinámicamente
    if (usuario) {
        updateFields.push(`usuario = $${counter}`);
        queryParams.push(usuario);
        counter++;
    }
    if (nombre_apellido) {
        updateFields.push(`nombre_apellido = $${counter}`);
        queryParams.push(nombre_apellido);
        counter++;
    }
    if (mail) {
        updateFields.push(`mail = $${counter}`);
        queryParams.push(mail);
        counter++;
    }
    if (rol_id) {
        updateFields.push(`rol_id = $${counter}`);
        queryParams.push(rol_id);
        counter++;
    }
    if (puesto_id) {
        updateFields.push(`puesto_id = $${counter}`);
        queryParams.push(puesto_id);
        counter++;
    }

    if (legajo) {
        updateFields.push(`legajo = $${counter}`);
        queryParams.push(legajo);
        counter++;
    }

    if (telefono) {
        updateFields.push(`telefono = $${counter}`);
        queryParams.push(telefono);
        counter++;
    }

    // Verificar si se envió una nueva contraseña
    if (pwd) {
        // Verificar si la contraseña ha cambiado: buscar la contraseña actual
        const userQuery = `SELECT pwd FROM usuario WHERE usuario_id = $1`;
        const userResult = await pool.query(userQuery, [usuario_id]);

        if (userResult.rowCount === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const currentPwd = userResult.rows[0].pwd;

        // Comprobar si la contraseña es la misma que la actual (evitar doble codificación)
        const bcrypt = require('bcrypt');
        const passwordMatch = await bcrypt.compare(pwd, currentPwd);

        if (!passwordMatch) {
            // Si la contraseña es nueva, codificarla
            const hashedPwd = await bcrypt.hash(pwd, 10);
            updateFields.push(`pwd = $${counter}`);
            queryParams.push(hashedPwd);
            counter++;
        }
    }

    // Verificar si hay campos para actualizar
    if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    // Agregar el usuario_id al final de los parámetros de la consulta
    queryParams.push(usuario_id);

    // Crear la consulta de actualización
    const updateQuery = `UPDATE usuario SET ${updateFields.join(', ')} WHERE usuario_id = $${counter} RETURNING *`;

    // Ejecutar la consulta
    const result = await pool.query(updateQuery, queryParams);

    // Si el usuario no se encuentra, devolver un error
    if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Devolver el usuario actualizado
    res.status(200).json({
        message: 'Usuario actualizado exitosamente',
        user: result.rows[0]
    });
});




app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
  });
  